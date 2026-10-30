//! `self` in a testing-secrets read made from a declared run's own checkout names that run.
//!
//! Core answers `GET jobs/<id>/testing-profiles/<profile>/secrets` to a job's credential with `self`,
//! and to a box's checkout credential with the id of a run a master on the box declared
//! (`packages/core/src/project-config/testing-secrets.ts:resolveTestingSecrets`). A declared run's
//! subagent shares its master's pane, so nothing in its shell says which run it is, and `self` is the
//! reading the route invites: adminhub-api's ISS-49 and ISS-85 judges (2026-10-30) sent `self` and ids
//! of their own making, and were refused `TESTING_SECRETS_NOT_A_JOB_CREDENTIAL` each time. The box
//! knows: the run is the checkout it was declared over, so `self` said from inside that checkout is
//! sent as the run's id, and the line saying so goes to stderr.

use std::path::{Path, PathBuf};

use runner_core::ledger::{Ledger, Run};

const SELF_READ: &str = "jobs/self/testing-profiles/";

/// Where `path` reads testing secrets as `self`, spelled any way `api` takes it, the index in
/// `path` at which `jobs/self/` begins.
fn self_read_at(path: &str) -> Option<usize> {
    let base = path.split(['?', '#']).next().unwrap_or("");
    let bare = base.trim_start_matches('/');
    let bare = bare.strip_prefix("api/").unwrap_or(bare);
    bare.starts_with(SELF_READ).then(|| base.len() - bare.len())
}

/// The checkout `dir` stands in: the nearest directory, `dir` or above it, that holds `.git`.
fn checkout_of(dir: &Path) -> Option<PathBuf> {
    dir.ancestors()
        .find(|d| d.join(".git").exists())
        .map(Path::to_path_buf)
}

/// What becomes of a call's path.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SelfNamed {
    /// No testing-secrets read as `self`: the path goes as written.
    Untouched,
    /// The read as the run declared over this checkout, and the line that says so.
    Run { path: String, note: String },
    /// A read as `self` no declared run here answers for: the path goes as written, and the line
    /// says why, since core's refusal of `self` under a box's credential cannot see this checkout.
    AsWritten(String),
}

/// `path` with `self` named as the open run declared over the checkout `here` stands in, read from
/// `ledger`.
pub(crate) fn name_self(
    path: &str,
    here: &Path,
    ledger: impl FnOnce() -> Result<Ledger, String>,
) -> SelfNamed {
    let Some(at) = self_read_at(path) else {
        return SelfNamed::Untouched;
    };
    let Some(tree) = checkout_of(here) else {
        return SelfNamed::AsWritten(format!(
            "note: `self` went as written: {} is in no checkout, so no run this box declared is named by it",
            here.display()
        ));
    };
    let run: Result<Option<Run>, String> =
        ledger().and_then(|led| led.open_run_at_tree(&tree).map_err(|e| e.to_string()));
    match run {
        Ok(Some(run)) => {
            let after = &path[at + "jobs/self".len()..];
            let sent = format!("{}jobs/{}{after}", &path[..at], run.run_id);
            SelfNamed::Run {
                note: format!(
                    "note: `self` is run {} here, the run this box declared over {}; sent as {sent}",
                    run.run_id,
                    tree.display()
                ),
                path: sent,
            }
        }
        Ok(None) => SelfNamed::AsWritten(format!(
            "note: `self` went as written: no open run this box declared is over {}, so `self` names only a job this credential runs",
            tree.display()
        )),
        Err(e) => SelfNamed::AsWritten(format!(
            "note: `self` went as written: this box's run ledger could not be read ({e})"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_core::ledger::NewRun;

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A box with one run declared over `<root>/run`, a checkout of its own, beside a pool job's
    /// checkout nested in it at `<root>/run/nested`.
    fn box_with_a_run(name: &str) -> (Scratch, Ledger) {
        let root =
            std::env::temp_dir().join(format!("forge-api-self-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let run = root.join("run");
        std::fs::create_dir_all(run.join("src")).unwrap();
        std::fs::write(run.join(".git"), "gitdir: /elsewhere\n").unwrap();
        std::fs::create_dir_all(run.join("nested")).unwrap();
        std::fs::write(run.join("nested/.git"), "gitdir: /elsewhere2\n").unwrap();
        let mut led = Ledger::open(&root.join("ledger.sqlite")).unwrap();
        led.create_run_group(NewRun {
            run_id: "53077902-cb16-408f-904c-e0e4b762a1c9".into(),
            project_id: "e42c7e01-e30c-4a1c-9198-9eb3dccdbf49".into(),
            master_session_id: "m".into(),
            worktree_path: run.clone(),
            boot_id: "b".into(),
            issue_keys: vec!["ISS-49".into()],
            role: Some("qa".into()),
        })
        .unwrap();
        (Scratch(root), led)
    }

    const READ: &str = "jobs/self/testing-profiles/stg/secrets?ref=secret://test/stg-admin";
    const AS_RUN: &str =
        "jobs/53077902-cb16-408f-904c-e0e4b762a1c9/testing-profiles/stg/secrets?ref=secret://test/stg-admin";

    /// adminhub-api ISS-49's judge, run 53077902, sent `self` from its own checkout and core was
    /// handed `self`, which names no job under a box's credential.
    #[test]
    fn self_said_in_a_declared_runs_checkout_is_sent_as_that_run() {
        let (root, _led) = box_with_a_run("named");
        for here in [root.0.join("run"), root.0.join("run/src")] {
            let got = name_self(READ, &here, || Ok(reopen(&root)));
            let SelfNamed::Run { path, note } = got else {
                panic!(
                    "`self` from {} was not named as the run: {got:?}",
                    here.display()
                );
            };
            assert_eq!(path, AS_RUN);
            assert!(
                note.contains("53077902-cb16-408f-904c-e0e4b762a1c9"),
                "{note}"
            );
        }
    }

    fn reopen(root: &Scratch) -> Ledger {
        Ledger::open(&root.0.join("ledger.sqlite")).unwrap()
    }

    #[test]
    fn every_spelling_of_the_path_keeps_its_own_prefix() {
        let (root, _led) = box_with_a_run("spell");
        for (asked, sent) in [
            (format!("/{READ}"), format!("/{AS_RUN}")),
            (format!("/api/{READ}"), format!("/api/{AS_RUN}")),
            (format!("api/{READ}"), format!("api/{AS_RUN}")),
        ] {
            let got = name_self(&asked, &root.0.join("run"), || Ok(reopen(&root)));
            assert!(
                matches!(&got, SelfNamed::Run { path, .. } if *path == sent),
                "{asked}: {got:?}"
            );
        }
    }

    /// A pool job's checkout nested in the run's is not the run's: its `self` is its own job's.
    #[test]
    fn self_in_any_other_checkout_or_an_ended_run_goes_as_written_saying_why() {
        let (root, led) = box_with_a_run("other");
        let nested = name_self(READ, &root.0.join("run/nested"), || Ok(reopen(&root)));
        assert!(
            matches!(&nested, SelfNamed::AsWritten(why) if why.contains("no open run")),
            "{nested:?}"
        );
        led.end_run("53077902-cb16-408f-904c-e0e4b762a1c9", "master", "judged")
            .unwrap();
        let ended = name_self(READ, &root.0.join("run"), || Ok(reopen(&root)));
        assert!(
            matches!(&ended, SelfNamed::AsWritten(why) if why.contains("no open run")),
            "{ended:?}"
        );
        let unread = name_self(READ, &root.0.join("run"), || Err("no such file".into()));
        assert!(
            matches!(&unread, SelfNamed::AsWritten(why) if why.contains("could not be read (no such file)")),
            "{unread:?}"
        );
    }

    #[test]
    fn a_path_that_is_no_testing_secrets_read_as_self_is_untouched() {
        let (root, _led) = box_with_a_run("untouched");
        for path in [
            AS_RUN,
            "jobs/self/events",
            "issues/self/testing-profiles/stg/secrets",
            "projects/p/testing-profiles",
        ] {
            assert_eq!(
                name_self(path, &root.0.join("run"), || Ok(reopen(&root))),
                SelfNamed::Untouched,
                "{path}"
            );
        }
    }
}
