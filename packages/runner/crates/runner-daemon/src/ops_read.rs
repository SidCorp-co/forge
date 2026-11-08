//! `ops.read`: core asks this box to run one read a support room's grant declares (ISS-871, REQ-77
//! BC-3), outside any session's sandbox.
//!
//! Core decided the room may: the read is declared in its grant and every argument fit its typed
//! parameter. The box runs the argv as it came, with no shell: `argv[0]` is the program, by absolute
//! path, and every other item is one argument, whatever it holds. The program keeps its own
//! credential (it runs as the daemon's user); the answer is what it printed, each stream cut to a
//! size core can scrub and hand on, and killed at the frame's timeout.
//!
//! ISS-707: a read may be code in the project's own repository, `repo:<path>`, run from the checkout
//! this box binds to the project, so every runner of the project runs the same reviewed program; and
//! the frame's `env` (the read's declared project secrets, which core read from the vault) is set on
//! that one process alone.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use runner_platform::config::Config;

use serde::Deserialize;
use serde_json::{json, Value};

use runner_transport::CoreClient;

use crate::checkout_frame::{serve, Channel, Frame};
use crate::host_command::{run_with_env, Ran, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS};

/// The most items an argv this box runs may hold, and the longest one.
const MAX_ARGS: usize = 40;
const MAX_ARG_CHARS: usize = 4_000;

/// A program versioned in the project's own repository, run from this box's checkout of it.
const REPO_PROGRAM: &str = "repo:";

/// The most variables one read is handed.
const MAX_ENV: usize = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpsReadFrame {
    request_id: String,
    project_id: String,
    argv: Vec<String>,
    #[serde(default)]
    timeout_ms: Option<u64>,
    #[serde(default)]
    runner_id: Option<String>,
    /// Set on the read's own process: its declared project secrets (ISS-707).
    #[serde(default)]
    env: BTreeMap<String, String>,
}

impl Frame for OpsReadFrame {
    fn request_id(&self) -> &str {
        &self.request_id
    }
    fn project_id(&self) -> &str {
        &self.project_id
    }
    fn runner_id(&self) -> Option<&str> {
        self.runner_id.as_deref()
    }
}

pub(crate) async fn handle(client: &CoreClient, data: Value) {
    serve(
        client,
        Channel::OpsRead,
        data,
        async |frame: &OpsReadFrame| {
            let checkout = checkout_of(&frame.project_id)?;
            let env = env_of(&frame.env)?;
            let ran = read_in(&frame.argv, frame.timeout_ms, &env, &checkout).await?;
            Ok(body(&ran, &frame.project_id))
        },
    )
    .await;
}

/// The checkout this box binds to `project_id`: where a `repo:` program is read from. A project this
/// box binds no checkout to runs no read here.
fn checkout_of(project_id: &str) -> Result<PathBuf, String> {
    let cfg = Config::load().map_err(|e| format!("this box's config could not be read: {e}"))?;
    cfg.bindings
        .values()
        .find(|b| b.project_id.as_deref() == Some(project_id))
        .map(|b| b.repo_path.clone())
        .ok_or_else(|| {
            format!("this box binds no checkout to project {project_id}, so it runs no read for it")
        })
}

/// The variables a read is handed, each a name a shell could hold and a value with no NUL.
fn env_of(env: &BTreeMap<String, String>) -> Result<Vec<(String, String)>, String> {
    if env.len() > MAX_ENV {
        return Err(format!(
            "an ops read is handed at most {MAX_ENV} variables; this one is {}",
            env.len()
        ));
    }
    for (name, value) in env {
        let mut chars = name.chars();
        let named = name.len() <= 64
            && chars.next().is_some_and(|c| c.is_ascii_uppercase())
            && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
        if !named {
            return Err(format!(
                "{name:?} is not a variable an ops read is handed: a capital letter, then capitals, digits or _"
            ));
        }
        if value.contains('\0') {
            return Err(format!("the value of {name} holds a NUL"));
        }
    }
    Ok(env.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
}

/// `repo:<path>` as the program in `checkout`: each segment a name, never `.` or `..`, and the file
/// it names inside the checkout once every link is followed, so no link carries it out.
fn repo_program(rel: &str, checkout: &Path) -> Result<PathBuf, String> {
    let named = !rel.is_empty()
        && rel
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..");
    if !named {
        return Err(format!(
            "{REPO_PROGRAM}{rel} is not a program in the project's checkout: a relative path with no . or .. segment"
        ));
    }
    let root = checkout
        .canonicalize()
        .map_err(|e| format!("the project's checkout could not be read on this box: {e}"))?;
    let program = root.join(rel).canonicalize().map_err(|e| {
        format!("{REPO_PROGRAM}{rel} is not in the project's checkout on this box: {e}")
    })?;
    if !program.starts_with(&root) {
        return Err(format!(
            "{REPO_PROGRAM}{rel} leads out of the project's checkout, so this box does not run it"
        ));
    }
    Ok(program)
}

/// Run `argv` with no shell, killed at `timeout_ms` (clamped), each stream capped.
#[cfg(test)]
pub(crate) async fn read(argv: &[String], timeout_ms: Option<u64>) -> Result<Ran, String> {
    read_in(argv, timeout_ms, &[], Path::new("/nonexistent")).await
}

/// [`read`] with `env` set on its process, a `repo:` program read from `checkout`. A refusal names
/// the program as the grant wrote it, never where the checkout sits on this box.
pub(crate) async fn read_in(
    argv: &[String],
    timeout_ms: Option<u64>,
    env: &[(String, String)],
    checkout: &Path,
) -> Result<Ran, String> {
    let resolved: Vec<String> = match argv.split_first() {
        Some((first, rest)) if first.starts_with(REPO_PROGRAM) => {
            let rel = &first[REPO_PROGRAM.len()..];
            let program = repo_program(rel, checkout)?;
            std::iter::once(program.to_string_lossy().into_owned())
                .chain(rest.iter().cloned())
                .collect()
        }
        _ => argv.to_vec(),
    };
    let (program, args) = program_and_args(&resolved)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    let ran = run_with_env(OsStr::new(program), args, timeout, env).await;
    match (ran, argv.first()) {
        (Err(e), Some(asked)) if asked != program => Err(e.replace(program, asked)),
        (ran, _) => ran,
    }
}

/// The program, an absolute path with no `.` or `..` segment, and its arguments as they came.
pub(crate) fn program_and_args(argv: &[String]) -> Result<(&str, &[String]), String> {
    let Some((program, args)) = argv.split_first() else {
        return Err("an ops read names no program: its argv is empty".into());
    };
    let absolute = program.starts_with('/')
        && program[1..]
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..");
    if !absolute {
        return Err(format!(
            "{program:?} is not a program this box runs for a read: an absolute path with no . or .. segment"
        ));
    }
    if argv.len() > MAX_ARGS {
        return Err(format!(
            "an ops read is at most {MAX_ARGS} items; this one is {}",
            argv.len()
        ));
    }
    if let Some(long) = argv.iter().find(|a| a.chars().count() > MAX_ARG_CHARS) {
        return Err(format!(
            "an ops read's item is at most {MAX_ARG_CHARS} characters; one is {}",
            long.chars().count()
        ));
    }
    if argv.iter().any(|a| a.contains('\0')) {
        return Err("an ops read's item holds a NUL".into());
    }
    Ok((program.as_str(), args))
}

fn body(ran: &Ran, project_id: &str) -> Value {
    json!({
        "projectId": project_id,
        "exitCode": ran.exit_code,
        "stdout": ran.stdout,
        "stderr": ran.stderr,
        "truncated": ran.truncated,
        "timedOut": ran.timed_out,
        "durationMs": ran.duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| (*s).to_string()).collect()
    }

    #[test]
    fn the_program_is_an_absolute_path_never_a_name_or_a_climb() {
        assert!(program_and_args(&argv(&["/usr/bin/env"])).is_ok());
        for bad in [
            vec![],
            argv(&["hub-logs"]),
            argv(&["./hub-logs"]),
            argv(&["/home/dev/../root/x"]),
            argv(&["/home/./x"]),
            argv(&["/home//x"]),
        ] {
            assert!(program_and_args(&bad).is_err(), "{bad:?}");
        }
        assert!(program_and_args(&argv(&["/bin/echo", "a\0b"])).is_err());
        let many: Vec<String> = std::iter::once("/bin/echo".to_string())
            .chain((0..MAX_ARGS).map(|i| i.to_string()))
            .collect();
        assert!(program_and_args(&many).is_err());
        assert!(program_and_args(&argv(&["/bin/echo", &"x".repeat(MAX_ARG_CHARS + 1)])).is_err());
    }

    /// Every item reaches the program as one argument: nothing on this box reads it as shell.
    #[cfg(unix)]
    #[tokio::test]
    async fn each_item_is_one_argument_and_no_shell_reads_it() {
        let planted =
            std::env::temp_dir().join(format!("ops-read-no-shell-{}", std::process::id()));
        let redirect = format!("x > {}", planted.display());
        let ran = read(
            &argv(&[
                "/usr/bin/printf",
                "[%s]\\n",
                "$(id); echo pwned",
                "a b",
                "`uname`",
                &redirect,
            ]),
            Some(10_000),
        )
        .await
        .unwrap();
        assert_eq!(ran.exit_code, Some(0), "{ran:?}");
        assert_eq!(
            ran.stdout,
            format!("[$(id); echo pwned]\n[a b]\n[`uname`]\n[{redirect}]\n")
        );
        assert!(!planted.exists(), "a shell wrote {}", planted.display());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_read_past_its_time_is_killed_and_said_timed_out() {
        let started = std::time::Instant::now();
        let ran = read(&argv(&["/bin/sleep", "30"]), Some(1_000))
            .await
            .unwrap();
        assert!(ran.timed_out);
        assert_eq!(ran.exit_code, None);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "it was not killed"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_flood_of_output_is_cut_to_the_cap_and_says_so() {
        let ran = read(
            &argv(&["/usr/bin/head", "-c", "200000", "/dev/zero"]),
            Some(10_000),
        )
        .await
        .unwrap();
        assert_eq!(ran.stdout.len(), crate::host_command::STREAM_CAP);
        assert!(ran.truncated);
        assert_eq!(ran.exit_code, Some(0));
    }

    #[tokio::test]
    async fn a_relative_program_runs_nothing() {
        let err = read(&argv(&["sh", "-c", "id"]), None).await.unwrap_err();
        assert!(err.contains("absolute path"), "{err}");
    }

    /// A checkout holding `scripts/ops/hello`, which prints its argument and the variable it is handed.
    #[cfg(unix)]
    fn checkout_with_a_read(tag: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("ops-read-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(root.join("scripts/ops")).unwrap();
        let script = root.join("scripts/ops/hello");
        std::fs::write(
            &script,
            "#!/bin/sh\necho \"hello $1 ${FORGE_OPS_TOKEN:-none}\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        root
    }

    /// ISS-707: the read is the project repo's code, run from this box's checkout, and the secret core
    /// handed is set on that one process, never on the daemon.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_repo_read_runs_from_the_checkout_with_its_secret_on_its_own_process() {
        let root = checkout_with_a_read("repo");
        let env = env_of(&BTreeMap::from([(
            "FORGE_OPS_TOKEN".to_string(),
            "fo_live_1".to_string(),
        )]))
        .unwrap();
        let ran = read_in(
            &argv(&["repo:scripts/ops/hello", "ORD1"]),
            Some(10_000),
            &env,
            &root,
        )
        .await
        .unwrap();
        assert_eq!(ran.exit_code, Some(0), "{ran:?}");
        assert_eq!(ran.stdout, "hello ORD1 fo_live_1\n");
        assert!(
            std::env::var("FORGE_OPS_TOKEN").is_err(),
            "the daemon took the secret"
        );
        let bare = read_in(
            &argv(&["repo:scripts/ops/hello", "x"]),
            Some(10_000),
            &[],
            &root,
        )
        .await
        .unwrap();
        assert_eq!(bare.stdout, "hello x none\n");
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// A `repo:` program never climbs out of the checkout, by a segment or by a link, and a refusal
    /// names it as the grant wrote it, never where the checkout sits on this box.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_repo_program_never_leaves_the_checkout() {
        let root = checkout_with_a_read("fence");
        std::os::unix::fs::symlink("/bin/echo", root.join("scripts/ops/out")).unwrap();
        for bad in [
            "repo:../x",
            "repo:/bin/echo",
            "repo:scripts//ops/hello",
            "repo:./scripts/ops/hello",
        ] {
            let err = read_in(&argv(&[bad]), Some(10_000), &[], &root)
                .await
                .unwrap_err();
            assert!(err.contains("no . or .. segment"), "{bad}: {err}");
        }
        let out = read_in(&argv(&["repo:scripts/ops/out"]), Some(10_000), &[], &root)
            .await
            .unwrap_err();
        assert!(out.contains("leads out of the project's checkout"), "{out}");
        let missing = read_in(&argv(&["repo:scripts/ops/gone"]), Some(10_000), &[], &root)
            .await
            .unwrap_err();
        assert!(missing.contains("repo:scripts/ops/gone"), "{missing}");
        assert!(!missing.contains(&*root.to_string_lossy()), "{missing}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_variable_is_a_shell_name_with_a_value_holding_no_nul() {
        let one = |k: &str, v: &str| BTreeMap::from([(k.to_string(), v.to_string())]);
        assert!(env_of(&one("FORGE_OPS_TOKEN", "v")).is_ok());
        for bad in ["forge_ops", "1TOKEN", "TOKEN-X", "", "PATH;X"] {
            assert!(env_of(&one(bad, "v")).is_err(), "{bad}");
        }
        assert!(env_of(&one("TOKEN", "a\0b")).is_err());
        let many: BTreeMap<String, String> = (0..=MAX_ENV)
            .map(|i| (format!("V{i}"), "x".to_string()))
            .collect();
        assert!(env_of(&many).is_err());
    }

    #[test]
    fn the_answer_carries_no_host_and_names_the_project() {
        let ran = Ran {
            exit_code: Some(0),
            stdout: "ok".into(),
            stderr: String::new(),
            truncated: false,
            timed_out: false,
            duration_ms: 3,
        };
        let b = body(&ran, "p-1");
        assert_eq!(b["projectId"], "p-1");
        assert_eq!(b["stdout"], "ok");
        assert!(b.get("host").is_none(), "{b}");
    }
}
