use super::*;

pub(crate) async fn supervise(
    client: &CoreClient,
    masters: &Arc<Masters>,
    tokens: Option<&session_tokens::SessionTokens>,
    project_id: &str,
    slug: &str,
) {
    let Some((session_id, name)) = masters.get(project_id) else {
        return;
    };

    // The reading recovery takes of the same pane (ISS-1312 criteria 45 and
    // 46). `terminal::alive` folds a tmux nobody could ask into `false`, and
    // closing on that ends a master that may be running and makes recovery
    // read its runs as having no master at all.
    let read = recovery_ports::pane_presence(&name).await;
    let unanswered = read == recovery::MasterPresence::Unanswered;
    if masters.note_unanswered(project_id, unanswered) && unanswered {
        tracing::warn!(
            "[master] {slug}: tmux could not be asked whether resident session {name} is there, so its core session is left open and it stays this project's master until tmux answers"
        );
    }
    if read == recovery::MasterPresence::Alive {
        if let Some(n) = masters.outlived(project_id) {
            let line = pane_exit::ended(slug, &name, n, pane_exit::Ended::StayedUp);
            tracing::info!("{line}");
        }
    }
    if read == recovery::MasterPresence::Gone {
        // Why the pane is gone, from what it printed after this box placed
        // it, said in the one line that says it is gone (ISS-1343). A pane
        // resuming a conversation Claude Code runs as a background session
        // exits at once saying so, and placing another only repeats that.
        let placed = masters.take_placed(project_id);
        let lived = placed.as_ref().map(|p| p.at.elapsed());
        let exit = match &placed {
            None => pane_exit::Exit::not_placed(),
            Some(PlacedPane { output: None, .. }) => pane_exit::Exit::no_transcript(),
            Some(PlacedPane {
                output: Some((path, from)),
                ..
            }) => pane_exit::classify(path, *from),
        };
        let counted = masters.count_exit(project_id, lived, &exit);
        if let Some(n) = counted.ended {
            let how = match counted.in_a_row {
                0 => pane_exit::Ended::NotEarly(lived),
                _ => pane_exit::Ended::OtherReason,
            };
            let line = pane_exit::ended(slug, &name, n, how);
            tracing::info!("{line}");
        }
        let in_a_row = counted.in_a_row;
        match pane_exit::journal(slug, &name, lived, &exit, in_a_row) {
            pane_exit::Say::Warn(line) => tracing::warn!("{line}"),
            pane_exit::Say::Error(line) => tracing::error!("{line}"),
            pane_exit::Say::Quiet(line) => tracing::debug!("{line}"),
        }
        if let pane_exit::Exit::Elsewhere {
            conversation,
            short,
        } = &exit
        {
            masters.note_elsewhere(project_id, conversation.clone(), short.clone());
        }
        record_exit(slug, &name, lived, in_a_row, exit);
        end_master(
            client,
            masters,
            tokens,
            project_id,
            &session_id,
            "terminal session vanished",
        )
        .await;
    }
}

/// Keep `exit` where `forge-runner master status` reads it, saying so where it
/// cannot be kept.
pub(crate) fn record_exit(
    slug: &str,
    name: &str,
    lived: Option<Duration>,
    in_a_row: u32,
    exit: pane_exit::Exit,
) {
    let dir = runner_platform::config::master_dir(slug).map_err(|e| e.to_string());
    keep_exit(slug, name, dir, &exit_record(name, lived, in_a_row, exit));
}

/// A pane core retired, kept as its last exit so `master status` never reads
/// the exit before it as this one (ISS-1098). Not an early exit: core ended it.
pub(crate) fn record_retired(
    masters: &Masters,
    project_id: &str,
    slug: &str,
    name: &str,
    because: &str,
) {
    let dir = runner_platform::config::master_dir(slug).map_err(|e| e.to_string());
    keep_exit(
        slug,
        name,
        dir,
        &retired_record(masters, project_id, name, because),
    );
}

fn retired_record(
    masters: &Masters,
    project_id: &str,
    name: &str,
    because: &str,
) -> pane_exit::Record {
    let lived = masters.take_placed(project_id).map(|p| p.at.elapsed());
    let exit = pane_exit::Exit::Retired {
        because: because.to_string(),
    };
    exit_record(name, lived, 0, exit)
}

fn exit_record(
    name: &str,
    lived: Option<Duration>,
    in_a_row: u32,
    exit: pane_exit::Exit,
) -> pane_exit::Record {
    pane_exit::Record {
        pane: name.to_string(),
        read_gone_at: master_limit::now_unix(),
        lived_secs: lived.map(|l| l.as_secs()),
        in_a_row,
        exit,
    }
}

fn keep_exit(
    slug: &str,
    name: &str,
    dir: Result<std::path::PathBuf, String>,
    record: &pane_exit::Record,
) {
    let written = dir.and_then(|dir| {
        pane_exit::write(&dir, record).map_err(|e| format!("{}: {e}", dir.display()))
    });
    if let Err(e) = written {
        tracing::warn!(
            "[master] {slug}: could not keep why {name} exited ({e}), so `forge-runner master status {slug}` cannot say it"
        );
    }
}

pub(crate) async fn end_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    tokens: Option<&session_tokens::SessionTokens>,
    project_id: &str,
    session_id: &str,
    reason: &str,
) {
    if let Err(e) = master_api::close(client, session_id, reason).await {
        tracing::warn!("[master] could not close session {session_id}: {e}");
    }
    if let Some(store) = tokens {
        store.retire(session_id);
        // The pane's own entry names the session it was placed under, which
        // is not this one where core moved the pane since (ISS-1316).
        if let Some((_, pane)) = masters.get(project_id) {
            store.retire_pane(project_id, &pane);
        }
    }
    masters.forget(project_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ISS-1098, 2026-11-07: core retired sidpeak's pane at 09:30:14Z and
    /// `master status` read "read gone 2d ago, 9607s after it was placed",
    /// the exit before it, because a retirement kept nothing.
    #[test]
    fn a_retired_pane_is_kept_as_its_last_exit_over_the_one_before() {
        let dir = std::env::temp_dir().join(format!("forge-retired-{}", uuid::Uuid::new_v4()));
        let mut older = exit_record(
            "forge-master-sidpeak",
            Some(Duration::from_secs(9607)),
            0,
            pane_exit::Exit::Silent,
        );
        older.read_gone_at -= 2 * 86_400;
        pane_exit::write(&dir, &older).expect("write the older exit");

        let masters = Masters::new();
        masters.note_placed("p1", None);
        let record = retired_record(
            &masters,
            "p1",
            "forge-master-sidpeak",
            "idle, children done",
        );
        keep_exit("sidpeak", "forge-master-sidpeak", Ok(dir.clone()), &record);

        let found = pane_exit::read(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        let pane_exit::Found::Record(kept) = found else {
            panic!("no last exit kept");
        };
        assert_eq!(
            kept.exit,
            pane_exit::Exit::Retired {
                because: "idle, children done".into()
            }
        );
        assert!(
            kept.read_gone_at > older.read_gone_at,
            "the retirement is not the newest exit"
        );
        assert!(
            kept.lived_secs.is_some_and(|s| s < 60),
            "it lived {:?}",
            kept.lived_secs
        );
        assert_eq!(kept.in_a_row, 0, "a retirement counted as an early exit");
        assert!(
            kept.exit.to_string().contains("core retired it"),
            "{}",
            kept.exit
        );
    }
}
