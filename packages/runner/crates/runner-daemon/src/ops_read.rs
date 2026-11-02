//! `ops.read`: core asks this box to run one read a support room's grant declares (ISS-871, REQ-77
//! BC-3), outside any session's sandbox.
//!
//! Core decided the room may: the read is declared in its grant and every argument fit its typed
//! parameter. The box runs the argv as it came, with no shell: `argv[0]` is the program, by absolute
//! path, and every other item is one argument, whatever it holds. The program keeps its own
//! credential (it runs as the daemon's user); the answer is what it printed, each stream cut to a
//! size core can scrub and hand on, and killed at the frame's timeout.

use std::ffi::OsStr;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use runner_transport::CoreClient;

use crate::checkout_frame::{serve, Channel, Frame};
use crate::host_command::{
    project_bound_here, run, Ran, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS,
};

/// The most items an argv this box runs may hold, and the longest one.
const MAX_ARGS: usize = 40;
const MAX_ARG_CHARS: usize = 4_000;

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
            project_bound_here(&frame.project_id)?;
            let ran = read(&frame.argv, frame.timeout_ms).await?;
            Ok(body(&ran, &frame.project_id))
        },
    )
    .await;
}

/// Run `argv` with no shell, killed at `timeout_ms` (clamped), each stream capped.
pub(crate) async fn read(argv: &[String], timeout_ms: Option<u64>) -> Result<Ran, String> {
    let (program, args) = program_and_args(argv)?;
    let timeout = Duration::from_millis(
        timeout_ms
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    );
    run(OsStr::new(program), args, timeout).await
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
    use crate::host_command::STREAM_CAP;
    use std::time::Instant;

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
        let started = Instant::now();
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
        assert_eq!(ran.stdout.len(), STREAM_CAP);
        assert!(ran.truncated);
        assert_eq!(ran.exit_code, Some(0));
    }

    #[tokio::test]
    async fn a_relative_program_runs_nothing() {
        let err = read(&argv(&["sh", "-c", "id"]), None).await.unwrap_err();
        assert!(err.contains("absolute path"), "{err}");
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
