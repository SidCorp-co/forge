//! What a pane inherits from the daemon's own environment, handed to it rather
//! than left to the tmux server that hosts it (ISS-1325).
//!
//! A pane takes its environment from the session server, and that server is a
//! long-lived process: one older than the daemon's configuration, or started by
//! the user manager and never by the daemon, hands every pane the environment
//! it began with. On 2026-09-29 that put the scratch of every pane, and a QA
//! run's browser profiles with it, on a RAM-backed `/tmp` the daemon's unit had
//! been told to leave. So the variables the daemon's own environment decides are
//! named here, passed to each pane as it is placed, and compared against the
//! server's global environment whenever a placement finds the server up.

use std::ffi::OsString;
use std::fmt;

use super::terminal;

/// The variables whose value the daemon's configuration decides for every pane
/// it places.
pub const OWNED: [&str; 1] = ["TMPDIR"];

/// What the daemon's environment says about one owned variable.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Said {
    Value(String),
    /// Unset, or set empty: either way the daemon has no value to give.
    Nothing,
    /// A value tmux's arguments cannot carry.
    NotUnicode,
}

fn said(name: &str, read: &dyn Fn(&str) -> Option<OsString>) -> Said {
    match read(name) {
        None => Said::Nothing,
        Some(v) if v.is_empty() => Said::Nothing,
        Some(v) => v.into_string().map_or(Said::NotUnicode, Said::Value),
    }
}

#[expect(
    clippy::disallowed_methods,
    reason = "the daemon's own value for each variable it owns, which is what a pane is handed"
)]
fn daemon_reads(name: &str) -> Option<OsString> {
    std::env::var_os(name)
}

/// The owned variables a pane is started with beyond what its `caller` named:
/// a variable the caller sets itself keeps the caller's value.
pub fn for_pane(caller: &[(String, String)]) -> Vec<(String, String)> {
    handed(caller, &daemon_reads)
}

fn handed(
    caller: &[(String, String)],
    read: &dyn Fn(&str) -> Option<OsString>,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for name in OWNED {
        if caller.iter().any(|(k, _)| k == name) {
            continue;
        }
        match said(name, read) {
            Said::Value(v) => out.push((name.to_string(), v)),
            Said::Nothing => {}
            Said::NotUnicode => tracing::warn!(
                "[terminal] the daemon's {name} is not valid UTF-8, which tmux cannot be handed, so a pane is placed without it and takes whatever its server holds"
            ),
        }
    }
    out
}

/// What comparing one owned variable against the session server's global
/// environment found, and did about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reconciled {
    Agreed,
    Set {
        name: &'static str,
        was: Option<String>,
        now: String,
    },
    Removed {
        name: &'static str,
        was: String,
    },
    SetRefused {
        name: &'static str,
        now: String,
        why: String,
    },
    RemoveRefused {
        name: &'static str,
        still: String,
        why: String,
    },
    Unread {
        name: &'static str,
        why: String,
    },
    /// The daemon's value cannot be handed to tmux, so the server is left as found.
    NotUnicode {
        name: &'static str,
    },
}

impl Reconciled {
    pub fn is_trouble(&self) -> bool {
        !matches!(
            self,
            Reconciled::Agreed | Reconciled::Set { .. } | Reconciled::Removed { .. }
        )
    }

    pub fn say(&self) {
        match self {
            Reconciled::Agreed => {}
            r if r.is_trouble() => tracing::warn!("[terminal] {r}"),
            r => tracing::info!("[terminal] {r}"),
        }
    }
}

fn shown(v: &Option<String>) -> String {
    v.as_ref()
        .map_or_else(|| "unset".to_string(), |v| format!("`{v}`"))
}

impl fmt::Display for Reconciled {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Reconciled::Agreed => write!(f, "the session server agrees with the daemon"),
            Reconciled::Set { name, was, now } => write!(
                f,
                "the session server's {name} was {} and is now `{now}`, the daemon's, so a pane it hosts starts with the daemon's value",
                shown(was)
            ),
            Reconciled::Removed { name, was } => write!(
                f,
                "the session server's {name} was `{was}` and is removed, because the daemon has none, so a pane it hosts no longer starts with a value the daemon does not hold"
            ),
            Reconciled::SetRefused { name, now, why } => write!(
                f,
                "could not set the session server's {name} to `{now}` ({why}); a pane this daemon places is still started with it, and one placed any other way inherits the server's"
            ),
            Reconciled::RemoveRefused { name, still, why } => write!(
                f,
                "could not remove the session server's {name} (`{still}`), which the daemon does not have ({why}); a pane placed on that server will inherit `{still}`"
            ),
            Reconciled::Unread { name, why } => write!(
                f,
                "could not read the session server's {name} ({why}), so it was not compared against the daemon's"
            ),
            Reconciled::NotUnicode { name } => write!(
                f,
                "the daemon's {name} is not valid UTF-8, so the session server's was left as found"
            ),
        }
    }
}

/// Compares the session server's global environment against the daemon's for
/// every owned variable and makes them agree, naming each change and each
/// refusal rather than serving a stale one.
pub async fn reconcile_server() -> Vec<Reconciled> {
    reconcile(wanted(&daemon_reads)).await
}

/// Variables a pane is handed one by one, per placement, and the server must
/// never carry: one the server inherited from wherever it was started would
/// reach a pane that was handed none, naming a copy this placement did not
/// resolve (ISS-1332).
const NEVER_ON_THE_SERVER: [&str; 1] = [super::pane_path::CLI_ENV];

fn wanted(read: &dyn Fn(&str) -> Option<OsString>) -> Vec<(&'static str, Said)> {
    OWNED
        .iter()
        .map(|name| (*name, said(name, read)))
        .chain(
            NEVER_ON_THE_SERVER
                .iter()
                .map(|name| (*name, Said::Nothing)),
        )
        .collect()
}

async fn reconcile(wants: Vec<(&'static str, Said)>) -> Vec<Reconciled> {
    let mut out = Vec::new();
    for (name, want) in wants {
        if want == Said::NotUnicode {
            out.push(Reconciled::NotUnicode { name });
            continue;
        }
        let held = match held_by_server(name).await {
            Ok(held) => held,
            Err(why) => {
                out.push(Reconciled::Unread { name, why });
                continue;
            }
        };
        out.push(match (want, held) {
            (Said::Value(now), Some(was)) if was == now => Reconciled::Agreed,
            (Said::Value(now), was) => {
                match terminal::tmux(&["set-environment", "-g", "--", name, &now]).await {
                    Ok(o) if o.status.success() => Reconciled::Set { name, was, now },
                    other => Reconciled::SetRefused {
                        name,
                        now,
                        why: refusal(other),
                    },
                }
            }
            (_, None) => Reconciled::Agreed,
            (_, Some(was)) => {
                match terminal::tmux(&["set-environment", "-g", "-u", "--", name]).await {
                    Ok(o) if o.status.success() => Reconciled::Removed { name, was },
                    other => Reconciled::RemoveRefused {
                        name,
                        still: was,
                        why: refusal(other),
                    },
                }
            }
        });
    }
    out
}

fn refusal(answer: crate::error::Result<std::process::Output>) -> String {
    match answer {
        Ok(o) => String::from_utf8_lossy(&o.stderr).trim().to_string(),
        Err(e) => e.to_string(),
    }
}

/// The server's global value for `name`: `Ok(None)` where it holds none, which
/// tmux says two ways (`unknown variable`, and a `-NAME` entry for one removed).
async fn held_by_server(name: &str) -> Result<Option<String>, String> {
    let out = terminal::tmux(&["show-environment", "-g", name])
        .await
        .map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if !out.status.success() {
        return if stderr.contains("unknown variable") {
            Ok(None)
        } else {
            Err(stderr)
        };
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let line = stdout.strip_suffix('\n').unwrap_or(&stdout);
    Ok(line.strip_prefix(&format!("{name}=")).map(str::to_string))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::auth::cred_store::{ScopedVar, ENV_TEST_LOCK};
    use std::collections::HashMap;

    /// Starts the session server as a process whose environment holds
    /// `TMPDIR=<held>`, or none, which is how a server older than the daemon's
    /// unit line stands.
    fn start_server(held: Option<&str>) {
        let sock = terminal::socket_path().expect("the isolated socket");
        let mut cmd = std::process::Command::new("tmux");
        cmd.args(["-S", &sock.to_string_lossy()])
            .args(["new-session", "-d", "-s", "older", "sleep", "600"])
            .env_remove("TMPDIR")
            .stdin(std::process::Stdio::null());
        if let Some(v) = held {
            cmd.env("TMPDIR", v);
        }
        assert!(
            cmd.status().expect("tmux runs").success(),
            "the server starts"
        );
    }

    async fn place(name: &str, caller: &[(String, String)]) -> HashMap<String, String> {
        let cwd = crate::test_scratch::Scratch::new("daemon-env-cwd");
        let argv = ["sleep", "601"].map(String::from);
        terminal::ensure(name, cwd.path(), &argv, caller, None)
            .await
            .expect("the pane is placed");
        let seen = terminal::testing::environ_once_running(name, "601").await;
        let _ = terminal::kill(name).await;
        seen
    }

    /// What the server's global environment holds for `TMPDIR`, as tmux says it.
    fn server_says() -> String {
        let sock = terminal::socket_path().expect("the isolated socket");
        let out = std::process::Command::new("tmux")
            .args(["-S", &sock.to_string_lossy(), "show-environment", "-g"])
            .args(["TMPDIR"])
            .output()
            .expect("tmux runs");
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
        .trim()
        .to_string()
    }

    /// A tmux server of this test's own, and the daemon's `TMPDIR` standing at
    /// the directory this process already uses: a test that moved it to a
    /// scratch would leave every test running beside it creating its own under
    /// one that is deleted when this one ends.
    struct World {
        // Fields drop in this order, and the two locks have to outlive everything
        // they guard: the isolation puts the config dir back when it drops, and
        // the next test must not have set its own by then.
        _daemon: ScopedVar,
        tmp: String,
        _iso: terminal::testing::IsolatedServer,
        _env: std::sync::MutexGuard<'static, ()>,
        _serial: tokio::sync::MutexGuard<'static, ()>,
    }

    impl World {
        async fn new(label: &str, daemon_has_it: bool) -> Option<Self> {
            let serial = terminal::testing::ONE_AT_A_TIME.lock().await;
            let env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let iso = terminal::testing::IsolatedServer::new(label);
            if !terminal::available() || !iso.took() {
                terminal::testing::cannot_run("no tmux of this test's own here");
                return None;
            }
            let probe = crate::test_scratch::Scratch::new("daemon-env-root");
            let tmp = probe
                .path()
                .parent()
                .and_then(std::path::Path::to_str)
                .expect("a utf-8 temp dir")
                .to_string();
            let daemon = if daemon_has_it {
                ScopedVar::set("TMPDIR", &tmp)
            } else {
                ScopedVar::unset("TMPDIR")
            };
            Some(Self {
                _daemon: daemon,
                tmp,
                _iso: iso,
                _env: env,
                _serial: serial,
            })
        }

        fn daemon_tmp(&self) -> String {
            self.tmp.clone()
        }
    }

    /// ISS-1325 criterion 1: the planted case. The server is older than the
    /// daemon's `TMPDIR`, which is the state the live box was in.
    #[tokio::test]
    async fn a_pane_on_a_server_older_than_the_daemons_tmpdir_carries_it() {
        let Some(w) = World::new("denvstale", true).await else {
            return;
        };
        start_server(None);
        let seen = place("forge-job-denv-stale", &[]).await;
        assert_eq!(
            seen.get("TMPDIR"),
            Some(&w.daemon_tmp()),
            "a pane placed on a server that never had the daemon's TMPDIR must still carry it"
        );
    }

    /// ISS-1325 criterion 2: the control, which holds without the fix, so the
    /// pair separates handing the value over from the server's inheriting it.
    #[tokio::test]
    async fn a_pane_on_a_server_that_holds_the_value_carries_it() {
        let Some(w) = World::new("denvheld", true).await else {
            return;
        };
        start_server(Some(&w.daemon_tmp()));
        let seen = place("forge-job-denv-held", &[]).await;
        assert_eq!(seen.get("TMPDIR"), Some(&w.daemon_tmp()));
    }

    /// ISS-1325 criterion 3.
    #[tokio::test]
    async fn a_variable_the_caller_names_keeps_the_callers_value() {
        let Some(w) = World::new("denvcaller", true).await else {
            return;
        };
        start_server(None);
        let caller = [("TMPDIR".to_string(), "/the/callers".to_string())];
        let seen = place("forge-job-denv-caller", &caller).await;
        assert_eq!(seen.get("TMPDIR").map(String::as_str), Some("/the/callers"));
        assert_ne!(w.daemon_tmp(), "/the/callers");
    }

    /// ISS-1325 criterion 4.
    #[test]
    fn a_daemon_with_no_tmpdir_or_an_empty_one_hands_nothing() {
        for held in [None, Some(OsString::new())] {
            let read = |_: &str| held.clone();
            assert_eq!(handed(&[], &read), Vec::new(), "{held:?}");
        }
        let read = |_: &str| Some(OsString::from("/x"));
        assert_eq!(
            handed(&[], &read),
            vec![("TMPDIR".to_string(), "/x".to_string())],
            "and a value is handed"
        );
    }

    /// ISS-1325 criterion 9.
    #[test]
    fn a_tmpdir_that_is_not_utf8_is_named_and_not_handed() {
        use std::os::unix::ffi::OsStringExt as _;
        let read = |_: &str| Some(OsString::from_vec(vec![b'/', 0xff, 0xfe]));
        let (said, guard) = crate::log_capture::capturing();
        let out = handed(&[], &read);
        drop(guard);
        assert_eq!(out, Vec::new());
        let said = said.said();
        assert!(
            said.contains("TMPDIR") && said.contains("not valid UTF-8"),
            "{said}"
        );
    }

    async fn a_server_holding(held: Option<&str>, shown: &str, label: &str) {
        let Some(w) = World::new(label, true).await else {
            return;
        };
        start_server(held);
        let found = reconcile_server().await;
        let now = w.daemon_tmp();
        assert_eq!(
            found,
            vec![
                Reconciled::Set {
                    name: "TMPDIR",
                    was: held.map(str::to_string),
                    now: now.clone()
                },
                Reconciled::Agreed
            ]
        );
        let said = found[0].to_string();
        assert!(
            said.contains(shown) && said.contains(&now),
            "the log names what it replaced and what it is now: {said}"
        );
        assert_eq!(server_says(), format!("TMPDIR={now}"));
        assert_eq!(
            reconcile_server().await,
            vec![Reconciled::Agreed, Reconciled::Agreed],
            "and a server that agrees is left alone"
        );
    }

    /// ISS-1325 criteria 5 and 6.
    #[tokio::test]
    async fn a_server_holding_another_tmpdir_is_set_to_the_daemons_and_the_old_one_is_named() {
        a_server_holding(Some("/an/old/tmp"), "`/an/old/tmp`", "denvset").await;
    }

    /// ISS-1325 criterion 5, where the server holds none.
    #[tokio::test]
    async fn a_server_holding_no_tmpdir_is_set_to_the_daemons_and_is_said_to_have_held_none() {
        a_server_holding(None, "was unset", "denvnone").await;
    }

    /// ISS-1325 criteria 7 and 8, and criterion 4 at the pane.
    #[tokio::test]
    async fn a_server_holding_a_tmpdir_the_daemon_has_none_of_loses_it_and_the_value_is_named() {
        let Some(_w) = World::new("denvrm", false).await else {
            return;
        };
        start_server(Some("/an/old/tmp"));
        let (log, guard) = crate::log_capture::capturing();
        let seen = place("forge-job-denv-rm", &[]).await;
        drop(guard);
        assert!(
            !seen.contains_key("TMPDIR"),
            "a pane placed on it carries none: {:?}",
            seen.get("TMPDIR")
        );
        assert_eq!(server_says(), "unknown variable: TMPDIR");
        let said = log.said();
        assert!(
            said.contains("TMPDIR") && said.contains("`/an/old/tmp`") && said.contains("removed"),
            "{said}"
        );
    }

    /// ISS-1325 criterion 10, 11 and 12: a server tmux will not change is named,
    /// and the pane is still placed with the daemon's value.
    #[tokio::test]
    async fn a_set_environment_tmux_refuses_is_named_and_the_pane_still_carries_the_value() {
        let Some(w) = World::new("denvrefs", true).await else {
            return;
        };
        start_server(None);
        let _refusing = terminal::testing::RefusingSetEnvironment::installed();
        let (log, guard) = crate::log_capture::capturing();
        let seen = place("forge-job-denv-refs", &[]).await;
        drop(guard);
        assert_eq!(seen.get("TMPDIR"), Some(&w.daemon_tmp()));
        let said = log.said();
        assert!(
            said.contains("could not set the session server's TMPDIR"),
            "{said}"
        );
        assert_eq!(
            server_says(),
            "unknown variable: TMPDIR",
            "and it changed nothing"
        );
    }

    /// ISS-1325 criterion 12.
    #[tokio::test]
    async fn a_removal_tmux_refuses_names_the_value_a_pane_will_inherit() {
        let Some(_w) = World::new("denvrefr", false).await else {
            return;
        };
        start_server(Some("/an/old/tmp"));
        let _refusing = terminal::testing::RefusingSetEnvironment::installed();
        let found = reconcile_server().await;
        assert!(
            matches!(
                found.as_slice(),
                [Reconciled::RemoveRefused { name: "TMPDIR", still, .. }, _] if still == "/an/old/tmp"
            ),
            "{found:?}"
        );
        let said = found[0].to_string();
        assert!(
            said.contains("TMPDIR") && said.contains("will inherit `/an/old/tmp`"),
            "{said}"
        );
        assert_eq!(server_says(), "TMPDIR=/an/old/tmp");
    }

    /// ISS-1332 criterion 3: a server that inherited a `forge` path this
    /// placement did not resolve does not hand it to the pane.
    #[tokio::test]
    async fn a_server_that_inherited_a_forge_path_does_not_hand_it_to_a_pane_with_none() {
        let Some(_w) = World::new("denvcli", true).await else {
            return;
        };
        let sock = terminal::socket_path().expect("the isolated socket");
        assert!(std::process::Command::new("tmux")
            .args(["-S", &sock.to_string_lossy()])
            .args(["new-session", "-d", "-s", "older", "sleep", "600"])
            .env("FORGE_CLI_PATH", "/old/copy/forge")
            .stdin(std::process::Stdio::null())
            .status()
            .expect("tmux runs")
            .success());
        let (log, guard) = crate::log_capture::capturing();
        let seen = place("forge-job-denv-cli", &[]).await;
        drop(guard);
        assert_eq!(seen.get("FORGE_CLI_PATH"), None);
        let said = log.said();
        assert!(
            said.contains("FORGE_CLI_PATH") && said.contains("`/old/copy/forge`"),
            "{said}"
        );
    }

    /// A value tmux cannot be handed leaves the server as it was.
    #[tokio::test]
    async fn a_tmpdir_that_is_not_utf8_leaves_the_server_as_found() {
        use std::os::unix::ffi::OsStringExt as _;
        let Some(_w) = World::new("denvnu", false).await else {
            return;
        };
        start_server(Some("/an/old/tmp"));
        let read = |_: &str| Some(OsString::from_vec(vec![b'/', 0xff]));
        assert_eq!(
            reconcile(wanted(&read)).await,
            vec![
                Reconciled::NotUnicode { name: "TMPDIR" },
                Reconciled::Agreed
            ]
        );
        assert_eq!(server_says(), "TMPDIR=/an/old/tmp");
    }
}
