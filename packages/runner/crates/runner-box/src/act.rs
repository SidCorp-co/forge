//! One driver command on a box (`box.act`): run with the box's environment, within a deadline,
//! its output cut to what the `act` report carries (`BOX_LIMITS.actStdoutBytes`, `actStderrBytes`).
//! Core classed it read or write and refused a write while a person holds the box; the runner runs
//! what it is told.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

pub const STDOUT_BYTES: usize = 65_536;
pub const STDERR_BYTES: usize = 16_384;
/// The longest one act may run: core answers its caller `pending` long before this.
pub const DEADLINE: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

impl Outcome {
    /// The `act` report core takes.
    pub fn report(&self, act_id: &str) -> Value {
        json!({
            "kind": "act",
            "actId": act_id,
            "exitCode": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "durationMs": self.duration_ms,
        })
    }

    pub fn failed(why: String, started: Instant) -> Self {
        Self {
            exit_code: -1,
            stdout: String::new(),
            stderr: cut(why.into_bytes(), STDERR_BYTES),
            duration_ms: started.elapsed().as_millis() as u64,
        }
    }
}

/// The text of `bytes`, at most `limit` bytes of it, cut on a character boundary and saying so.
pub fn cut(bytes: Vec<u8>, limit: usize) -> String {
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if text.len() <= limit {
        return text;
    }
    let note = "\n[cut: the act printed more than Forge keeps]";
    let mut end = limit.saturating_sub(note.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{note}", &text[..end])
}

/// Run `cmd` to its end or `deadline`, whichever is first; a command past it is killed.
pub async fn run(mut cmd: tokio::process::Command, deadline: Duration) -> Outcome {
    let started = Instant::now();
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Outcome::failed(format!("the driver did not start: {e}"), started),
    };
    let (mut out, mut err) = (child.stdout.take(), child.stderr.take());
    let read = async {
        let (mut o, mut e) = (Vec::new(), Vec::new());
        let (a, b) = tokio::join!(
            async {
                if let Some(s) = out.as_mut() {
                    let _ = s.read_to_end(&mut o).await;
                }
            },
            async {
                if let Some(s) = err.as_mut() {
                    let _ = s.read_to_end(&mut e).await;
                }
            }
        );
        let ((), ()) = (a, b);
        let status = child.wait().await;
        (status, o, e)
    };
    match tokio::time::timeout(deadline, read).await {
        Ok((status, o, e)) => Outcome {
            exit_code: status.ok().and_then(|s| s.code()).unwrap_or(-1),
            stdout: cut(o, STDOUT_BYTES),
            stderr: cut(e, STDERR_BYTES),
            duration_ms: started.elapsed().as_millis() as u64,
        },
        Err(_) => Outcome::failed(
            format!("the act ran past {} s and was stopped", deadline.as_secs()),
            started,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_act_reports_its_exit_its_output_cut_to_the_limit_and_a_slow_one_is_stopped() {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.args(["-c", "printf out; printf err >&2; exit 3"]);
        let o = run(cmd, Duration::from_secs(10)).await;
        assert_eq!(
            (o.exit_code, o.stdout.as_str(), o.stderr.as_str()),
            (3, "out", "err")
        );

        let long = cut(vec![b'x'; STDOUT_BYTES + 10], STDOUT_BYTES);
        assert!(long.len() <= STDOUT_BYTES && long.ends_with("Forge keeps]"));

        let mut slow = tokio::process::Command::new("sleep");
        slow.arg("5").kill_on_drop(true);
        let o = run(slow, Duration::from_millis(200)).await;
        assert_eq!(o.exit_code, -1);
        assert!(o.stderr.contains("ran past"), "{}", o.stderr);
    }
}
