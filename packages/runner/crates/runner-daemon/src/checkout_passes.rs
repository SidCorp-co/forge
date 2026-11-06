//! The passes over every bound checkout that run after the daemon's start: the start's own
//! again where core did not answer it, and the orientation refresh for as long as the daemon
//! runs, so project knowledge edited after a start reaches the checkout within one heartbeat.
//! `forge-runner sync` runs the same write on demand ([`sync_orientations`]).

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use runner_core::agent_activity;
use runner_platform::config::Config;
use runner_platform::error::Result;
use runner_transport::heartbeat::Revisions;
use runner_transport::runners::{self, MeRunner};
use runner_transport::CoreClient;
use runner_workspace::orientation_record::{converge_every, Entry, Outcome, Point};
use tokio::sync::watch;

use crate::{orientation_targets, reconcile_checkouts, repair_installed_hooks};

/// Where a start's pass reads the bindings again and records what it did.
pub(crate) struct StartPlaces {
    /// config.toml as it stands now, so the census covers a binding made since start.
    reload: Box<dyn Fn() -> Result<Config> + Send + Sync>,
    record_dir: Option<std::path::PathBuf>,
    lock_dir: Option<std::path::PathBuf>,
}

impl StartPlaces {
    pub(crate) fn this_box() -> Self {
        let record_dir = runner_platform::config::config_dir();
        let lock_dir = record_dir.as_deref().map(|d| d.join("locks"));
        Self {
            reload: Box::new(Config::load),
            record_dir,
            lock_dir,
        }
    }
}

/// The start's pass over every checkout this box is bound to: the hooks the daemon it replaced
/// installed, then the forge-master skill and the orientation core served. `server` is `None`
/// where core did not answer which projects are assigned here.
pub(crate) async fn start_pass(
    server: Option<&[MeRunner]>,
    cfg: &Config,
    when: &str,
    places: &StartPlaces,
) {
    repair_installed_hooks(server, cfg, when);
    let census_from = agent_activity::now_ms();
    let (fresh, census_from) = match (places.reload)() {
        Ok(fresh) => (fresh, Some(census_from)),
        Err(e) => {
            tracing::warn!(
                "[skill] config.toml could not be read again ({e}), so the forge-master install covers the bindings read at start and prunes no line of its record"
            );
            (cfg.clone(), None)
        }
    };
    reconcile_checkouts(
        server,
        &fresh,
        census_from,
        places.record_dir.as_deref(),
        places.lock_dir.as_deref(),
    )
    .await;
}

/// How long a start core did not answer waits before asking again: the first wait, doubled on
/// each failure up to the second.
const START_RETRY: (std::time::Duration, std::time::Duration) = (
    std::time::Duration::from_secs(5),
    std::time::Duration::from_secs(300),
);

/// A start whose `me/runners` read failed wrote no orientation and swept only config.toml's
/// checkouts, and no later point owes that pass: a provision writes only the checkout it
/// provisions. So the read is asked again until core answers, and the start's whole pass runs
/// then over what it served. On 2026-10-15 and 2026-10-20 the dev box's daemon started 14 s
/// after the host booted, before name resolution worked, and every checkout kept an
/// orientation older than the project knowledge core was serving until the next restart.
/// Answers whether the pass ran; `false` where the daemon stopped first.
pub(crate) async fn start_pass_once_core_answers(
    client: &CoreClient,
    cfg: &Config,
    places: &StartPlaces,
    (first, cap): (std::time::Duration, std::time::Duration),
    mut cancel: watch::Receiver<bool>,
) -> bool {
    let mut wait = first;
    let mut failed: u32 = 1;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = cancel.changed() => {
                tracing::warn!(
                    "[me/runners] this daemon stopped before core answered which projects are assigned to it, so the start's orientation, forge-master skill and hook pass never ran over what core serves"
                );
                return false;
            }
        }
        match runners::list_me(client).await {
            Ok(rows) => {
                tracing::info!(
                    "[me/runners] core answered after {failed} failed read(s) since this daemon started — the start's orientation, forge-master skill and hook pass runs now over the {} assignment(s) it served",
                    rows.len()
                );
                start_pass(Some(&rows), cfg, "once core answered", places).await;
                return true;
            }
            Err(e) => {
                failed += 1;
                wait = (wait * 2).min(cap);
                tracing::warn!(
                    "[me/runners] still unanswered ({e}) — {failed} failed read(s) since start; every checkout keeps the orientation it held before this start, and the read is asked again in {}s",
                    wait.as_secs()
                );
            }
        }
    }
}

/// The orientation core serves carries the project's knowledge, which a person edits while this
/// daemon runs: a rule added on 2026-10-09 had reached no checkout on this box by 2026-10-22, and
/// on 2026-11-07 85 deleted entries stayed listed in both forge checkouts until a refresh came
/// round. So every heartbeat answer names each assigned project's orientation revision (the
/// sha256 of the body `me/runners` serves), and a project whose revision differs from the one
/// this loop last wrote has `me/runners` read and its checkout converged over it, within the beat
/// that named it. A revision that has not moved reads nothing and writes nothing. Nothing is
/// written yet when the loop starts, so the first answer converges every checkout once, which
/// also covers a start core did not answer. A read core did not answer writes nothing, records
/// why on each checkout it owed, and is asked again on the next beat. Ends when `cancel` says
/// stop or the heartbeat is gone.
async fn refresh_orientations(
    client: &CoreClient,
    cfg: &Config,
    places: &StartPlaces,
    mut revisions: watch::Receiver<Option<Revisions>>,
    mut cancel: watch::Receiver<bool>,
) {
    let mut written: HashMap<String, String> = HashMap::new();
    let mut said_none = false;
    loop {
        tokio::select! {
            beat = revisions.changed() => if beat.is_err() { return; },
            stop = cancel.changed() => {
                if stop.is_err() || *cancel.borrow() { return; }
                continue;
            }
        }
        let Some(served) = revisions.borrow_and_update().clone() else {
            if !said_none {
                tracing::warn!(
                    "[orientation] core's heartbeat names no orientation revisions (a core older than this runner, or one that could not compose them), so no checkout's orientation is refreshed until it does; `forge-runner sync` writes it now"
                );
                said_none = true;
            }
            continue;
        };
        said_none = false;
        let moved: BTreeSet<String> = served
            .iter()
            .filter(|(project, revision)| written.get(*project) != Some(*revision))
            .map(|(project, _)| project.clone())
            .collect();
        if !moved.is_empty() {
            refresh_moved(client, cfg, places, &served, &moved, &mut written).await;
        }
    }
}

/// Converge the checkouts of the `moved` projects over what `me/runners` serves now, and note in
/// `written` the revision each was converged at. A checkout whose provision lock could not be
/// taken at all is left un-noted, so the next beat tries it again; a refusal is not, since the
/// next beat would meet it again and the record already names it.
async fn refresh_moved(
    client: &CoreClient,
    cfg: &Config,
    places: &StartPlaces,
    served: &Revisions,
    moved: &BTreeSet<String>,
    written: &mut HashMap<String, String>,
) {
    let rows = match runners::list_me(client).await {
        Ok(rows) => Some(rows),
        Err(e) => {
            tracing::warn!(
                "[orientation] at refresh: the heartbeat named a moved orientation revision for {} project(s) and me/runners failed ({e}) — every checkout keeps the orientation it holds, and the next beat asks again",
                moved.len()
            );
            None
        }
    };
    let fresh = (places.reload)().unwrap_or_else(|e| {
        tracing::warn!(
            "[orientation] at refresh: config.toml could not be read again ({e}), so this pass covers the bindings read at start"
        );
        cfg.clone()
    });
    let owed: Vec<_> = orientation_targets(Point::Refresh, rows.as_deref(), &fresh)
        .into_iter()
        .filter(|b| b.project_id.as_ref().is_some_and(|p| moved.contains(p)))
        .collect();
    let entries = converge_every(
        Point::Refresh,
        &owed,
        places.lock_dir.as_deref(),
        places.record_dir.as_deref(),
        None,
    )
    .await;
    let Some(rows) = rows else { return };
    for row in rows.iter().filter(|r| moved.contains(&r.project_id)) {
        let retry = owed.iter().zip(&entries).any(|(b, e)| {
            b.project_id.as_deref() == Some(row.project_id.as_str())
                && matches!(e.outcome, Outcome::Failed { .. })
        });
        let revision = row
            .orientation_revision
            .clone()
            .or_else(|| served.get(&row.project_id).cloned());
        if let (false, Some(revision)) = (retry, revision) {
            written.insert(row.project_id.clone(), revision);
        }
    }
}

/// The passes over every checkout that run after the start: the start's own again where core
/// did not `answer` it, and the orientation refresh, driven by the revisions each heartbeat
/// answer names, for as long as the daemon runs. Answers where the heartbeat publishes them.
pub(crate) fn spawn_checkout_passes(
    answered: bool,
    client: &Arc<CoreClient>,
    cfg: &Config,
    cancel_rx: &watch::Receiver<bool>,
) -> watch::Sender<Option<Revisions>> {
    let (published, revisions) = watch::channel(None);
    if !answered {
        let (client, cfg, cancel) = (client.clone(), cfg.clone(), cancel_rx.clone());
        tokio::spawn(async move {
            let places = StartPlaces::this_box();
            start_pass_once_core_answers(&client, &cfg, &places, START_RETRY, cancel).await
        });
    }
    let (client, cfg, cancel) = (client.clone(), cfg.clone(), cancel_rx.clone());
    tokio::spawn(async move {
        let places = StartPlaces::this_box();
        refresh_orientations(&client, &cfg, &places, revisions, cancel).await
    });
    published
}

/// `forge-runner sync`: write the orientation core serves now into every bound checkout, or only
/// `only_slug`'s, whatever revision the daemon last wrote, and record each outcome where
/// `forge-runner status` reads it. Fails only where `me/runners` cannot be read; a slug bound to
/// no checkout here answers no entry, which the caller names.
pub async fn sync_orientations(
    client: &CoreClient,
    cfg: &Config,
    only_slug: Option<&str>,
) -> Result<Vec<Entry>> {
    sync_orientations_in(client, cfg, only_slug, &StartPlaces::this_box()).await
}

async fn sync_orientations_in(
    client: &CoreClient,
    cfg: &Config,
    only_slug: Option<&str>,
    places: &StartPlaces,
) -> Result<Vec<Entry>> {
    let rows = runners::list_me(client).await?;
    let owed: Vec<_> = orientation_targets(Point::Sync, Some(&rows), cfg)
        .into_iter()
        .filter(|b| only_slug.is_none_or(|s| b.slug == s))
        .collect();
    Ok(converge_every(
        Point::Sync,
        &owed,
        places.lock_dir.as_deref(),
        places.record_dir.as_deref(),
        None,
    )
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::start_tests::{git, outcomes, DEV};
    use runner_platform::config::Binding;
    use runner_workspace::orientation_record::{self, Outcome};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// How many times the core below was asked which projects are assigned to the box.
    static ASKED: AtomicUsize = AtomicUsize::new(0);

    /// A core that cannot answer `me/runners` the first two times it is asked, as a host that
    /// booted before name resolution worked, and serves the forge orientation after.
    fn answers_on_the_third_read(path: &str) -> (u16, &'static str) {
        if path != "/api/devices/me/runners" {
            return (200, "{}");
        }
        if ASKED.fetch_add(1, Ordering::SeqCst) < 2 {
            return (503, r#"{"error":"starting"}"#);
        }
        (
            200,
            r##"[{"projectId":"d1bb4907-74d9-4228-85ff-76121523af7d","runnerId":"r","slug":"forge","status":"online","orientation":"# Forge orientation — forge\n\n<!-- Generated by Forge on device provision. Forge-owned; manual edits are overwritten. -->\n\n- **projectId:** `d1bb4907-74d9-4228-85ff-76121523af7d`\n\n## ui-copy-rule\n"}]"##,
        )
    }

    #[tokio::test]
    async fn a_start_core_did_not_answer_writes_the_orientation_once_core_answers() {
        let root = std::env::temp_dir().join(format!("forge-start-late-{}", uuid::Uuid::new_v4()));
        let co = root.join("co");
        std::fs::create_dir_all(&co).unwrap();
        git(&co, &["init", "-q"]);
        let records = root.join("config");
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "forge".into(),
            Binding {
                repo_path: co.clone(),
                branch: None,
                project_id: Some(DEV.into()),
            },
        );
        let reloaded = cfg.clone();
        let places = StartPlaces {
            reload: Box::new(move || Ok(reloaded.clone())),
            record_dir: Some(records.clone()),
            lock_dir: Some(records.join("locks")),
        };
        let (client, _seen) = crate::test_core::fake_core(answers_on_the_third_read).await;
        let (_stop, cancel) = watch::channel(false);
        let quick = (
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(20),
        );

        // The start itself: core does not answer, so nothing is written and the refusal is recorded.
        assert!(runners::list_me(&client).await.is_err());
        start_pass(None, &cfg, "boot", &places).await;
        assert!(!co.join("CLAUDE.local.md").exists());

        let ran = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            start_pass_once_core_answers(&client, &cfg, &places, quick, cancel),
        )
        .await
        .expect("START_PASS_NEVER_RETRIED: the start's pass waited past 10 s for a core that answers on its third read");
        assert!(ran, "START_PASS_NEVER_RETRIED: core answered on its third read and the start's pass was never run again over what it served");
        assert_eq!(
            ASKED.load(Ordering::SeqCst),
            3,
            "asked until core answered, and no more"
        );
        let local = std::fs::read_to_string(co.join("CLAUDE.local.md")).unwrap_or_else(|e| {
            panic!("START_ORIENTATION_NOT_WRITTEN_ONCE_CORE_ANSWERED: core answered on its third read and the checkout holds no CLAUDE.local.md ({e})")
        });
        assert!(local.contains("## ui-copy-rule"), "{local}");
        let said = outcomes(&records);
        assert!(
            matches!(&said[0], (s, o) if s == "forge" && o.oriented()),
            "the record still says the start's refusal: {said:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_start_pass_waiting_on_core_ends_when_the_daemon_stops() {
        let (client, _seen) = crate::test_core::fake_core(|_| (503, r#"{"error":"down"}"#)).await;
        let places = StartPlaces {
            reload: Box::new(|| Ok(Config::default())),
            record_dir: None,
            lock_dir: None,
        };
        let (stop, cancel) = watch::channel(false);
        let waiting = tokio::spawn(async move {
            start_pass_once_core_answers(
                &client,
                &Config::default(),
                &places,
                (
                    std::time::Duration::from_millis(5),
                    std::time::Duration::from_millis(20),
                ),
                cancel,
            )
            .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(60)).await;
        let _ = stop.send(true);
        let ran = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("a stopped daemon's start pass kept asking core")
            .unwrap();
        assert!(!ran, "a pass core never answered is not reported as run");
    }

    /// The forge rows core serves while a guide is still listed, and the revision it names.
    const LISTED: &str = r##"[{"projectId":"d1bb4907-74d9-4228-85ff-76121523af7d","runnerId":"r","slug":"forge","status":"online","orientation":"# Forge orientation — forge\n\n<!-- Generated by Forge on device provision. Forge-owned; manual edits are overwritten. -->\n\n- **projectId:** `d1bb4907-74d9-4228-85ff-76121523af7d`\n\n## Project guides (fetch on demand)\n- dev-release\n- onboarding-code-map-jobs\n","orientationRevision":"r-listed"}]"##;
    const LISTED_BEAT: &str =
        r#"{"ok":true,"orientations":{"d1bb4907-74d9-4228-85ff-76121523af7d":"r-listed"}}"#;
    /// The same once that guide's knowledge entry is deleted in core.
    const DELETED: &str = r##"[{"projectId":"d1bb4907-74d9-4228-85ff-76121523af7d","runnerId":"r","slug":"forge","status":"online","orientation":"# Forge orientation — forge\n\n<!-- Generated by Forge on device provision. Forge-owned; manual edits are overwritten. -->\n\n- **projectId:** `d1bb4907-74d9-4228-85ff-76121523af7d`\n\n## Project guides (fetch on demand)\n- dev-release\n","orientationRevision":"r-deleted"}]"##;
    const DELETED_BEAT: &str =
        r#"{"ok":true,"orientations":{"d1bb4907-74d9-4228-85ff-76121523af7d":"r-deleted"}}"#;

    /// A core that serves `LISTED` until `stage` turns 1 and `DELETED` after, counting its
    /// `me/runners` reads in `reads`; `me/runners` answers 503 while `stage` is 2.
    fn deletion_core(path: &str, stage: &AtomicUsize, reads: &AtomicUsize) -> (u16, &'static str) {
        let stage = stage.load(Ordering::SeqCst);
        match path {
            "/api/devices/heartbeat" if stage == 0 => (200, LISTED_BEAT),
            "/api/devices/heartbeat" => (200, DELETED_BEAT),
            "/api/devices/me/runners" => {
                reads.fetch_add(1, Ordering::SeqCst);
                match stage {
                    0 => (200, LISTED),
                    1 => (200, DELETED),
                    _ => (503, r#"{"error":"down"}"#),
                }
            }
            _ => (200, "{}"),
        }
    }

    /// A bound forge checkout, the places its passes record into, and its config.
    fn bound_forge(tag: &str) -> (PathBuf, PathBuf, Config, StartPlaces) {
        let root = std::env::temp_dir().join(format!("forge-{tag}-{}", uuid::Uuid::new_v4()));
        let co = root.join("co");
        std::fs::create_dir_all(&co).unwrap();
        git(&co, &["init", "-q"]);
        let records = root.join("config");
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "forge".into(),
            Binding {
                repo_path: co.clone(),
                branch: None,
                project_id: Some(DEV.into()),
            },
        );
        let reloaded = cfg.clone();
        let places = StartPlaces {
            reload: Box::new(move || Ok(reloaded.clone())),
            record_dir: Some(records.clone()),
            lock_dir: Some(records.join("locks")),
        };
        (root, co, cfg, places)
    }

    /// The forge checkout's record line, once `done` holds of it, within 5 s.
    async fn forge_line_once(
        records: &Path,
        done: impl Fn(&orientation_record::Entry) -> bool,
    ) -> Option<orientation_record::Entry> {
        let until = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while tokio::time::Instant::now() < until {
            if let orientation_record::Read::Record(r) = orientation_record::read(records) {
                if let Some(e) = r.entries.into_iter().find(|e| e.slug == "forge" && done(e)) {
                    return Some(e);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        None
    }

    fn local_of(co: &Path) -> (String, std::time::SystemTime) {
        let local = co.join("CLAUDE.local.md");
        (
            std::fs::read_to_string(&local).unwrap(),
            std::fs::metadata(&local).unwrap().modified().unwrap(),
        )
    }

    static MOVED_STAGE: AtomicUsize = AtomicUsize::new(0);
    static MOVED_READS: AtomicUsize = AtomicUsize::new(0);
    fn moved_core(path: &str) -> (u16, &'static str) {
        deletion_core(path, &MOVED_STAGE, &MOVED_READS)
    }

    /// ISS-1066 criterion 2: a beat naming a moved revision rewrites the checkout's orientation
    /// before the next beat, and a beat naming the revision already written reads nothing from
    /// `me/runners` and leaves the file as it stands.
    #[tokio::test]
    async fn a_moved_revision_rewrites_the_orientation_within_one_beat_and_an_unmoved_one_touches_nothing(
    ) {
        let (root, co, cfg, places) = bound_forge("revision");
        let records = places.record_dir.clone().unwrap();
        let (client, _seen) = crate::test_core::fake_core(moved_core).await;
        let rows = runners::list_me(&client).await.unwrap();
        start_pass(Some(&rows), &cfg, "boot", &places).await;
        assert!(local_of(&co).0.contains("- onboarding-code-map-jobs"));

        let (beats, revisions) = watch::channel(None);
        let (stop, cancel) = watch::channel(false);
        let refreshing = {
            let client = client.clone();
            tokio::spawn(async move {
                refresh_orientations(&client, &cfg, &places, revisions, cancel).await
            })
        };
        let none = Default::default();
        let beat = || crate::actors::beat_once(&client, &none, &beats);

        // The first beat after start: nothing written by this loop yet, so it converges once.
        beat().await;
        let first = forge_line_once(&records, |e| {
            e.point == Point::Refresh && e.outcome == Outcome::Current
        })
        .await;
        assert!(
            first.is_some(),
            "the first beat converged nothing within 5 s"
        );
        assert_eq!(MOVED_READS.load(Ordering::SeqCst), 2);
        let held = local_of(&co);

        for _ in 0..3 {
            beat().await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(
            MOVED_READS.load(Ordering::SeqCst),
            2,
            "ORIENTATION_READ_UNMOVED: a beat naming the revision already written read me/runners again"
        );
        assert_eq!(
            local_of(&co),
            held,
            "ORIENTATION_TOUCHED_UNMOVED: a beat naming the revision already written changed the file"
        );

        // A guide's knowledge entry is deleted in core: the next beat names a moved revision.
        MOVED_STAGE.store(1, Ordering::SeqCst);
        beat().await;
        let written = forge_line_once(&records, |e| {
            e.point == Point::Refresh && e.outcome == Outcome::Written
        })
        .await;
        assert!(
            written.is_some(),
            "ORIENTATION_NOT_REFRESHED: the beat naming a moved revision wrote nothing within 5 s, with no later beat"
        );
        let (now, _) = local_of(&co);
        assert!(
            !now.contains("onboarding-code-map-jobs") && now.contains("- dev-release"),
            "ORIENTATION_NOT_REFRESHED: the checkout still lists the deleted guide:\n{now}"
        );
        assert_eq!(MOVED_READS.load(Ordering::SeqCst), 3);

        let after = local_of(&co);
        beat().await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(MOVED_READS.load(Ordering::SeqCst), 3);
        assert_eq!(local_of(&co), after);

        let _ = stop.send(true);
        tokio::time::timeout(std::time::Duration::from_secs(5), refreshing)
            .await
            .expect("REFRESH_OUTLIVED_STOP: the refresh loop kept running after the daemon stopped")
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    static DOWN_STAGE: AtomicUsize = AtomicUsize::new(0);
    static DOWN_READS: AtomicUsize = AtomicUsize::new(0);
    fn down_core(path: &str) -> (u16, &'static str) {
        deletion_core(path, &DOWN_STAGE, &DOWN_READS)
    }

    /// A moved revision whose `me/runners` read core did not answer keeps the checkout, records
    /// why, and is asked again on the next beat until core answers.
    #[tokio::test]
    async fn a_refresh_core_did_not_answer_keeps_the_checkout_records_why_and_asks_again() {
        let (root, co, cfg, places) = bound_forge("refresh-unanswered");
        let records = places.record_dir.clone().unwrap();
        let (client, _seen) = crate::test_core::fake_core(down_core).await;
        let rows = runners::list_me(&client).await.unwrap();
        start_pass(Some(&rows), &cfg, "boot", &places).await;
        let before = local_of(&co).0;

        let (beats, revisions) = watch::channel(None);
        let (stop, cancel) = watch::channel(false);
        let refreshing = {
            let client = client.clone();
            tokio::spawn(async move {
                refresh_orientations(&client, &cfg, &places, revisions, cancel).await
            })
        };
        DOWN_STAGE.store(2, Ordering::SeqCst);
        crate::actors::beat_once(&client, &Default::default(), &beats).await;
        let refused = forge_line_once(&records, |e| {
            e.point == Point::Refresh
                && matches!(&e.outcome, Outcome::Refused { detail } if detail.starts_with("PROVISION_ORIENTATION_NOT_SERVED"))
        })
        .await;
        assert!(
            refused.is_some(),
            "REFRESH_FAILURE_UNRECORDED: a refresh whose read core did not answer recorded no refusal within 5 s"
        );
        assert_eq!(
            local_of(&co).0,
            before,
            "a refresh core did not answer changed the checkout"
        );

        DOWN_STAGE.store(1, Ordering::SeqCst);
        crate::actors::beat_once(&client, &Default::default(), &beats).await;
        let written = forge_line_once(&records, |e| {
            e.point == Point::Refresh && e.outcome == Outcome::Written
        })
        .await;
        assert!(
            written.is_some(),
            "REFRESH_NOT_RETRIED: the beat after a failed read did not ask again"
        );
        assert!(!local_of(&co).0.contains("onboarding-code-map-jobs"));
        let _ = stop.send(true);
        tokio::time::timeout(std::time::Duration::from_secs(5), refreshing)
            .await
            .expect("REFRESH_OUTLIVED_STOP")
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    static SILENT_READS: AtomicUsize = AtomicUsize::new(0);
    /// A core older than ISS-1066: its heartbeat names no revisions.
    fn names_no_revisions(path: &str) -> (u16, &'static str) {
        match path {
            "/api/devices/heartbeat" => (200, r#"{"ok":true}"#),
            "/api/devices/me/runners" => {
                SILENT_READS.fetch_add(1, Ordering::SeqCst);
                (200, DELETED)
            }
            _ => (200, "{}"),
        }
    }

    #[tokio::test]
    async fn a_heartbeat_naming_no_revisions_reads_and_writes_nothing() {
        let (root, co, cfg, places) = bound_forge("refresh-silent");
        std::fs::write(co.join("CLAUDE.local.md"), "mine\n").unwrap();
        let (client, _seen) = crate::test_core::fake_core(names_no_revisions).await;
        let (beats, revisions) = watch::channel(None);
        let (stop, cancel) = watch::channel(false);
        let refreshing = {
            let client = client.clone();
            tokio::spawn(async move {
                refresh_orientations(&client, &cfg, &places, revisions, cancel).await
            })
        };
        for _ in 0..3 {
            crate::actors::beat_once(&client, &Default::default(), &beats).await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert_eq!(SILENT_READS.load(Ordering::SeqCst), 0);
        assert_eq!(local_of(&co).0, "mine\n");
        let _ = stop.send(true);
        tokio::time::timeout(std::time::Duration::from_secs(5), refreshing)
            .await
            .expect("REFRESH_OUTLIVED_STOP")
            .unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    static SYNC_STAGE: AtomicUsize = AtomicUsize::new(0);
    static SYNC_READS: AtomicUsize = AtomicUsize::new(0);
    fn sync_core(path: &str) -> (u16, &'static str) {
        deletion_core(path, &SYNC_STAGE, &SYNC_READS)
    }

    /// ISS-1066 criterion 3: `forge-runner sync --project <slug>` writes what core serves now into
    /// that checkout, with no daemon and whatever revision was last written, and only that one.
    #[tokio::test]
    async fn sync_for_a_project_rewrites_its_checkouts_orientation_and_no_other() {
        let (root, co, mut cfg, _) = bound_forge("sync");
        let epod = root.join("epod");
        std::fs::create_dir_all(&epod).unwrap();
        git(&epod, &["init", "-q"]);
        cfg.bindings.insert(
            "epod".into(),
            Binding {
                repo_path: epod.clone(),
                branch: None,
                project_id: Some("00000000-0000-4000-8000-0000000000e9".into()),
            },
        );
        let records = root.join("config");
        // never `Config::load`: that is this box's own config.toml, and a pass over it writes
        // into the box's real checkouts
        let reloaded = cfg.clone();
        let places = StartPlaces {
            reload: Box::new(move || Ok(reloaded.clone())),
            record_dir: Some(records.clone()),
            lock_dir: Some(records.join("locks")),
        };
        let (client, _seen) = crate::test_core::fake_core(sync_core).await;
        let rows = runners::list_me(&client).await.unwrap();
        start_pass(Some(&rows), &cfg, "boot", &places).await;
        assert!(local_of(&co).0.contains("- onboarding-code-map-jobs"));

        SYNC_STAGE.store(1, Ordering::SeqCst);
        let said = sync_orientations_in(&client, &cfg, Some("forge"), &places)
            .await
            .unwrap();
        assert_eq!(said.len(), 1, "{said:?}");
        assert_eq!(
            (said[0].slug.as_str(), said[0].point),
            ("forge", Point::Sync)
        );
        assert_eq!(said[0].outcome, Outcome::Written, "{said:?}");
        let (now, _) = local_of(&co);
        assert!(
            !now.contains("onboarding-code-map-jobs") && now.contains("- dev-release"),
            "SYNC_DID_NOT_REWRITE: {now}"
        );
        assert!(
            !epod.join("CLAUDE.local.md").exists(),
            "sync --project forge wrote another project's checkout"
        );
        let line = forge_line_once(&records, |e| e.point == Point::Sync).await;
        assert!(
            line.is_some(),
            "the sync's write is not in the record status reads"
        );

        let again = sync_orientations_in(&client, &cfg, Some("forge"), &places)
            .await
            .unwrap();
        assert_eq!(again[0].outcome, Outcome::Current);
        let none = sync_orientations_in(&client, &cfg, Some("nope"), &places)
            .await
            .unwrap();
        assert!(none.is_empty(), "{none:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
