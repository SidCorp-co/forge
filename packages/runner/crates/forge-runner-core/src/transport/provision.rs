//! Device workspace-provisioning transport.
//!
//! - `pull_pending`  — `GET /api/devices/me/provisions`: the device's `queued`
//!   provisions (clone target + the project's git SSH private key, decrypted +
//!   delivered once over TLS — mirrors the ISS-305 credential side-channel),
//!   plus whatever core could not build, named in a header beside them.
//! - `report_status` — `POST /api/devices/me/runners/:runnerId/provision-status`:
//!   advance the live stepper (`cloning` → `syncing_skills` → `writing_mcp` →
//!   `ready` | `needs_manual_setup` | `failed`).
//!
//! Field casing mirrors core JSON (camelCase). Pull model: an offline device
//! just picks rows up on its next poll, so bind never blocks on presence.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// One queued provision for this device. `ssh_private_key` is present only when
/// the project has a git credential AND the server could decrypt it;
/// `mcp_credential` only when the server could resolve the identity this box
/// acts as. Both are secrets — see the hand-written `Debug` below, which
/// redacts them so a `{:?}` in a log line cannot leak one.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provision {
    pub runner_id: String,
    pub project_id: String,
    pub slug: String,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub repo_url: Option<String>,
    pub ssh_key_source: Option<String>,
    pub ssh_public_key: Option<String>,
    pub ssh_private_key: Option<String>,
    #[serde(default)]
    pub github_app_credential: bool,
    /// The token to write into this checkout's `.mcp.json`, minted by core for
    /// (this device × this project) so a person running `claude` in the folder
    /// reaches Forge without pasting one in by hand.
    #[serde(default)]
    pub mcp_credential: Option<String>,
}

impl std::fmt::Debug for Provision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held = |v: &Option<String>| if v.is_some() { "<redacted>" } else { "none" };
        f.debug_struct("Provision")
            .field("runner_id", &self.runner_id)
            .field("project_id", &self.project_id)
            .field("slug", &self.slug)
            .field("repo_path", &self.repo_path)
            .field("branch", &self.branch)
            .field("repo_url", &self.repo_url)
            .field("ssh_key_source", &self.ssh_key_source)
            .field("ssh_public_key", &self.ssh_public_key)
            .field("ssh_private_key", &held(&self.ssh_private_key))
            .field("github_app_credential", &self.github_app_credential)
            .field("mcp_credential", &held(&self.mcp_credential))
            .finish()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportBody<'a> {
    status: &'a str,
    detail: Option<&'a str>,
}

/// One queued provision this device was NOT given, and why.
///
/// Core omits the row from the array and names it in the
/// `X-Forge-Provision-Failures` header instead, so one project's fault costs
/// this box that project rather than every other one it was waiting on
/// (ISS-1184). `kind` is `omitted` for a row that yielded no provision, and
/// `degraded` for one that was served with something core could not supply.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionFailure {
    pub slug: String,
    pub project_id: String,
    pub runner_id: String,
    pub kind: String,
    pub reason: String,
}

/// What one poll came back with. `dropped` counts failures that did not fit the
/// header's budget — those are on the runner's own row in web.
#[derive(Debug, Clone, Default)]
pub struct Pending {
    pub provisions: Vec<Provision>,
    pub failures: Vec<ProvisionFailure>,
    pub dropped: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reported {
    #[serde(default)]
    pub failures: Vec<ProvisionFailure>,
    #[serde(default)]
    pub dropped: usize,
}

pub(crate) const FAILURES_HEADER: &str = "x-forge-provision-failures";

/// What core reported this poll, or nothing when it reported nothing. A header
/// this build cannot read is not a reason to discard the provisions that came
/// with it, so it degrades to no failures and says so.
pub(crate) fn parse_failures(raw: Option<&str>) -> Reported {
    let Some(raw) = raw else {
        return Reported::default();
    };
    match serde_json::from_str::<Reported>(raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            tracing::warn!("[provision] could not read the failures core reported: {e}");
            Reported::default()
        }
    }
}

/// Fetch the device's queued provisions, and whatever core could not build.
/// Empty when nothing is queued.
///
/// Every error out of here names the endpoint it called, so the caller's one
/// log line is attributable without reading this file: the refusal an operator
/// meets says `GET <url> answered <status>` and carries the body core sent.
pub async fn pull_pending(client: &CoreClient) -> Result<Pending> {
    let url = client.url("/api/devices/me/provisions");
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("provisions request to GET {url} never got an answer: {e}")))?;
    let status = resp.status();
    if !status.is_success() {
        let body = match resp.text().await {
            Ok(raw) => body_excerpt(&raw),
            Err(e) => format!("<could not be read: {e}>"),
        };
        return Err(Error::Other(format!(
            "provisions failed: GET {url} answered {status}, body: {body}"
        )));
    }
    let reported = parse_failures(
        resp.headers()
            .get(FAILURES_HEADER)
            .and_then(|v| v.to_str().ok()),
    );
    let provisions = resp
        .json::<Vec<Provision>>()
        .await
        .map_err(|e| Error::Other(format!("provisions decode from GET {url}: {e}")))?;
    journal(streak().succeeded(Instant::now()));
    Ok(Pending {
        provisions,
        failures: reported.failures,
        dropped: reported.dropped,
    })
}

/// How much of a refusal's body reaches the journal. Long enough that a
/// gateway's error page is recognisable from the first line of it, short
/// enough that a refusal repeating for a day cannot fill a disk.
const BODY_CAP: usize = 400;

/// Consecutive refusals of ONE subject before the condition stops being a
/// warning. Chosen so a deploy window — a few polls of `503` while core
/// restarts — passes without an error, and a real outage does not.
const ESCALATE_AFTER: u32 = 5;

/// One poll's response body as a log line carries it: whitespace collapsed so
/// a multi-line HTML error page stays one journal entry, and cut at
/// [`BODY_CAP`] with the cut declared. An empty body says so — a line ending
/// in `body: ` reads as a bug in this code rather than as core answering with
/// nothing.
fn body_excerpt(raw: &str) -> String {
    let flat = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        return "<none>".to_string();
    }
    let len = flat.chars().count();
    if len <= BODY_CAP {
        return flat;
    }
    let head: String = flat.chars().take(BODY_CAP).collect();
    format!("{head}… (cut at {BODY_CAP} of {len} characters)")
}

/// A span as an operator reads one, coarse on purpose: the question a streak
/// answers is *minutes or hours*, never *how many seconds*.
fn span(d: Duration) -> String {
    let secs = d.as_secs();
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m {}s", secs / 60, secs % 60),
        _ => format!("{}h {}m", secs / 3600, (secs % 3600) / 60),
    }
}

/// What one pull outcome earns in the journal.
///
/// The sweep polls every 90 seconds forever, so *what happened* and *what is
/// written down* are different questions: a refusal that repeats a refusal
/// already reported earns [`Entry::Nothing`], which is how 685 identical
/// subject-less lines in a day (ISS-1206) stop being written.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    /// This outcome repeats one already reported.
    Nothing,
    /// A refusal nobody has been told about: a new subject, or the first after
    /// a run of successes.
    Refused(String),
    /// The same refusal has stood for [`ESCALATE_AFTER`] polls. Said once, at
    /// error, and this is the last line until the subject changes or it clears.
    Escalated {
        subject: String,
        count: u32,
        held: Duration,
    },
    /// A success that ended a streak somebody was told about. It carries the
    /// subject so the recovery is attributable to the refusal it cleared,
    /// rather than telling an operator that something unnamed has stopped.
    Recovered {
        subject: String,
        count: u32,
        held: Duration,
    },
}

/// Consecutive refusals carrying one subject.
///
/// The subject IS the error's own text, which after `pull_pending` above
/// carries the endpoint, the status and the body: two refusals differing in
/// any of those are different conditions and each earns its own line. That is
/// what separates a `502` from the edge from a `500` from a handler, which on
/// this box alternated for days behind one indistinguishable warning.
#[derive(Debug, Default)]
struct Streak {
    subject: Option<String>,
    count: u32,
    first: Option<Instant>,
}

impl Streak {
    const fn new() -> Self {
        Self {
            subject: None,
            count: 0,
            first: None,
        }
    }

    /// Record one refusal and say what the journal owes for it.
    fn refused(&mut self, subject: &str, now: Instant) -> Entry {
        if self.subject.as_deref() != Some(subject) {
            self.subject = Some(subject.to_string());
            self.count = 1;
            self.first = Some(now);
            return Entry::Refused(subject.to_string());
        }
        self.count = self.count.saturating_add(1);
        if self.count == ESCALATE_AFTER {
            return Entry::Escalated {
                subject: subject.to_string(),
                count: self.count,
                held: now.saturating_duration_since(self.first.unwrap_or(now)),
            };
        }
        Entry::Nothing
    }

    /// Record one success and say what the journal owes for it. A success
    /// with no streak standing owes nothing: the sweep is a no-op most of the
    /// time and does not narrate itself.
    fn succeeded(&mut self, now: Instant) -> Entry {
        let Some(first) = self.first.take() else {
            return Entry::Nothing;
        };
        let count = std::mem::take(&mut self.count);
        let subject = self.subject.take().unwrap_or_default();
        Entry::Recovered {
            subject,
            count,
            held: now.saturating_duration_since(first),
        }
    }
}

static PULL_STREAK: Mutex<Streak> = Mutex::new(Streak::new());

fn streak() -> MutexGuard<'static, Streak> {
    PULL_STREAK.lock().unwrap_or_else(|e| e.into_inner())
}

fn journal(entry: Entry) {
    match entry {
        Entry::Nothing => {}
        Entry::Refused(subject) => tracing::warn!("[provision] pull failed: {subject}"),
        Entry::Escalated {
            subject,
            count,
            held,
        } => tracing::error!(
            "[provision] pull failed {count} consecutive times over {}, and nothing further will be logged about it until the refusal changes or the pull succeeds: {subject}",
            span(held)
        ),
        Entry::Recovered {
            subject,
            count,
            held,
        } => tracing::info!(
            "[provision] pull recovered after {count} consecutive refusal(s) over {}, which were: {subject}",
            span(held)
        ),
    }
}

/// Put one refused pull in the journal, or deliberately not.
///
/// The caller logged this unconditionally until ISS-1206, which is how one box
/// wrote 685 identical `provisions failed: 500 Internal Server Error` lines in
/// a day — a repeating failure with no subject that could be noticed and not
/// triaged. The policy is here rather than at the call site because the
/// success half of it ([`Streak::succeeded`]) is in `pull_pending` above, and
/// one piece of state cannot have two owners.
pub fn report_pull_refusal(e: &Error) {
    let entry = streak().refused(&e.to_string(), Instant::now());
    journal(entry);
}

/// Report provision progress for one runner. Best-effort: callers log on `Err`.
pub async fn report_status(
    client: &CoreClient,
    runner_id: &str,
    status: &str,
    detail: Option<&str>,
) -> Result<()> {
    let url = client.url(&format!(
        "/api/devices/me/runners/{runner_id}/provision-status"
    ));
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&ReportBody { status, detail })
        .send()
        .await
        .map_err(|e| Error::Other(format!("provision-status request: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::Other(format!(
            "provision-status failed: {}",
            resp.status()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_failures_core_named() {
        let reported = parse_failures(Some(
            r#"{"failures":[{"slug":"epod-cli","projectId":"p1","runnerId":"r1","kind":"omitted","reason":"duplicate key value"}],"dropped":2}"#,
        ));
        assert_eq!(reported.failures.len(), 1);
        assert_eq!(reported.failures[0].slug, "epod-cli");
        assert_eq!(reported.failures[0].reason, "duplicate key value");
        assert_eq!(reported.dropped, 2);
    }

    #[test]
    fn reports_nothing_when_the_header_is_absent() {
        let reported = parse_failures(None);
        assert!(reported.failures.is_empty());
        assert_eq!(reported.dropped, 0);
    }

    #[test]
    fn keeps_the_provisions_when_the_header_cannot_be_read() {
        // A build older or newer than the server's shape must not lose the
        // provisions that came with the header it could not parse.
        let reported = parse_failures(Some("not json at all"));
        assert!(reported.failures.is_empty());
        assert_eq!(reported.dropped, 0);
    }

    /// The body of one refusal, as a journal line carries it.
    #[test]
    fn a_body_reaches_the_journal_as_one_line() {
        let raw = "Internal Server Error\n  at handler (/app/src/devices/me-provisions.ts:41)\n";
        assert_eq!(
            body_excerpt(raw),
            "Internal Server Error at handler (/app/src/devices/me-provisions.ts:41)"
        );
    }

    /// A line ending in `body: ` reads as this code being broken. It has to
    /// say that core answered with nothing, which is itself a fact about the
    /// refusal — a `520` from an edge carries a page, a `503` from a proxy
    /// often carries nothing at all.
    #[test]
    fn an_empty_body_is_named_rather_than_left_blank() {
        assert_eq!(body_excerpt(""), "<none>");
        assert_eq!(body_excerpt("   \n\t "), "<none>");
    }

    #[test]
    fn a_body_under_the_cap_is_carried_whole() {
        let raw = "x".repeat(BODY_CAP);
        assert_eq!(body_excerpt(&raw), raw);
    }

    /// The cut is declared, and the whole length with it: an operator reading
    /// `cut at 400 of 12480 characters` knows there is more and how much.
    #[test]
    fn a_body_over_the_cap_is_cut_and_says_so() {
        let raw = "y".repeat(BODY_CAP + 2048);
        let out = body_excerpt(&raw);
        assert_eq!(out.chars().take(BODY_CAP).collect::<String>(), "y".repeat(BODY_CAP));
        assert!(
            out.ends_with(&format!("… (cut at {BODY_CAP} of {} characters)", BODY_CAP + 2048)),
            "{out}"
        );
    }

    /// A multi-byte body must be cut on character boundaries, not bytes: a cut
    /// through a UTF-8 sequence panics the slice and takes the sweep with it.
    #[test]
    fn a_multi_byte_body_is_cut_without_splitting_a_character() {
        let raw = "é".repeat(BODY_CAP + 10);
        let out = body_excerpt(&raw);
        assert!(out.starts_with(&"é".repeat(BODY_CAP)), "{out}");
    }

    fn refusal(status: &str) -> String {
        format!("provisions failed: GET http://core/api/devices/me/provisions answered {status}, body: <none>")
    }

    #[test]
    fn the_first_refusal_of_a_fresh_process_is_reported() {
        let mut s = Streak::new();
        assert_eq!(
            s.refused(&refusal("500"), Instant::now()),
            Entry::Refused(refusal("500"))
        );
    }

    /// 685 identical lines in a day is what this replaces (ISS-1206): the
    /// second through fourth repeats say nothing an operator did not read the
    /// first time.
    #[test]
    fn a_repeat_of_a_reported_refusal_says_nothing() {
        let mut s = Streak::new();
        let now = Instant::now();
        s.refused(&refusal("500"), now);
        for n in 1..=3 {
            assert_eq!(
                s.refused(&refusal("500"), now + Duration::from_secs(90 * n)),
                Entry::Nothing,
                "repeat {n}"
            );
        }
    }

    #[test]
    fn the_fifth_consecutive_refusal_escalates_once_with_its_count_and_span() {
        let mut s = Streak::new();
        let now = Instant::now();
        let mut last = Entry::Nothing;
        for n in 0..5 {
            last = s.refused(&refusal("500"), now + Duration::from_secs(90 * n));
        }
        assert_eq!(
            last,
            Entry::Escalated {
                subject: refusal("500"),
                count: 5,
                held: Duration::from_secs(360),
            }
        );
    }

    /// The escalation said it was the last line about this condition, so it
    /// has to be one. A sixth line would make the promise false and the
    /// journal noisy again.
    #[test]
    fn nothing_further_is_written_once_a_streak_has_escalated() {
        let mut s = Streak::new();
        let now = Instant::now();
        for n in 0..5 {
            s.refused(&refusal("500"), now + Duration::from_secs(90 * n));
        }
        for n in 5..40 {
            assert_eq!(
                s.refused(&refusal("500"), now + Duration::from_secs(90 * n)),
                Entry::Nothing,
                "poll {n}"
            );
        }
    }

    /// Measured on sid-xeon-1: `500`, then `502`, then `503`, then `520`, all
    /// behind one indistinguishable warning. A different status is a different
    /// condition and is reported as one.
    #[test]
    fn a_refusal_that_changed_is_reported_and_starts_its_own_streak() {
        let mut s = Streak::new();
        let now = Instant::now();
        for n in 0..5 {
            s.refused(&refusal("500"), now + Duration::from_secs(90 * n));
        }
        assert_eq!(
            s.refused(&refusal("502 Bad Gateway"), now + Duration::from_secs(450)),
            Entry::Refused(refusal("502 Bad Gateway"))
        );
        for n in 6..9 {
            assert_eq!(
                s.refused(&refusal("502 Bad Gateway"), now + Duration::from_secs(90 * n)),
                Entry::Nothing,
                "poll {n}"
            );
        }
        assert_eq!(
            s.refused(&refusal("502 Bad Gateway"), now + Duration::from_secs(810)),
            Entry::Escalated {
                subject: refusal("502 Bad Gateway"),
                count: 5,
                held: Duration::from_secs(360),
            },
            "the new subject's streak is counted from its own first refusal"
        );
    }

    /// Two refusals sharing a status but not a body are two conditions: core
    /// answering `503` because it is restarting and an edge answering `503`
    /// with nothing behind it are not the same incident.
    #[test]
    fn two_refusals_sharing_a_status_but_not_a_body_are_different_subjects() {
        let mut s = Streak::new();
        let now = Instant::now();
        s.refused("provisions failed: GET u answered 503, body: core restarting", now);
        assert!(matches!(
            s.refused(
                "provisions failed: GET u answered 503, body: no healthy upstream",
                now + Duration::from_secs(90)
            ),
            Entry::Refused(_)
        ));
    }

    #[test]
    fn a_success_that_ends_a_streak_names_what_it_ended() {
        let mut s = Streak::new();
        let now = Instant::now();
        for n in 0..7 {
            s.refused(&refusal("500"), now + Duration::from_secs(90 * n));
        }
        assert_eq!(
            s.succeeded(now + Duration::from_secs(630)),
            Entry::Recovered {
                subject: refusal("500"),
                count: 7,
                held: Duration::from_secs(630),
            }
        );
    }

    /// The sweep is a no-op almost every time it runs. A success with nothing
    /// standing is not news, and a line per 90 seconds saying so would be the
    /// defect this issue is about, wearing the other sign.
    #[test]
    fn a_success_with_no_streak_standing_says_nothing() {
        let mut s = Streak::new();
        assert_eq!(s.succeeded(Instant::now()), Entry::Nothing);
        s.refused(&refusal("500"), Instant::now());
        s.succeeded(Instant::now());
        assert_eq!(s.succeeded(Instant::now()), Entry::Nothing);
    }

    #[test]
    fn a_span_is_rendered_at_the_scale_an_operator_asked_about() {
        assert_eq!(span(Duration::from_secs(0)), "0s");
        assert_eq!(span(Duration::from_secs(59)), "59s");
        assert_eq!(span(Duration::from_secs(60)), "1m 0s");
        assert_eq!(span(Duration::from_secs(3599)), "59m 59s");
        assert_eq!(span(Duration::from_secs(3600)), "1h 0m");
        assert_eq!(span(Duration::from_secs(75_600)), "21h 0m");
    }

    /// What the journal receives for each entry, at which level. A policy that
    /// decides correctly and then writes the decision at the wrong level is
    /// invisible to an operator filtering on `error`.
    fn logged_while(f: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex as StdMutex};
        #[derive(Clone)]
        struct Buf(Arc<StdMutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(StdMutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn a_reported_refusal_reaches_the_journal_at_warn_with_its_subject() {
        let out = logged_while(|| journal(Entry::Refused(refusal("500 Internal Server Error"))));
        assert!(out.contains("WARN"), "{out}");
        assert!(out.contains("[provision] pull failed:"), "{out}");
        assert!(out.contains("GET http://core/api/devices/me/provisions"), "{out}");
        assert!(out.contains("500 Internal Server Error"), "{out}");
    }

    #[test]
    fn an_escalation_reaches_the_journal_at_error_with_its_count_and_span() {
        let out = logged_while(|| {
            journal(Entry::Escalated {
                subject: refusal("500 Internal Server Error"),
                count: 5,
                held: Duration::from_secs(75_600),
            })
        });
        assert!(out.contains("ERROR"), "{out}");
        assert!(out.contains("5 consecutive times"), "{out}");
        assert!(out.contains("21h 0m"), "{out}");
        assert!(out.contains("GET http://core/api/devices/me/provisions"), "{out}");
    }

    #[test]
    fn a_recovery_reaches_the_journal_at_info_naming_what_it_ended() {
        let out = logged_while(|| {
            journal(Entry::Recovered {
                subject: refusal("500 Internal Server Error"),
                count: 685,
                held: Duration::from_secs(75_600),
            })
        });
        assert!(out.contains("INFO"), "{out}");
        assert!(out.contains("685 consecutive refusal(s)"), "{out}");
        assert!(out.contains("21h 0m"), "{out}");
        assert!(out.contains("GET http://core/api/devices/me/provisions"), "{out}");
    }

    #[test]
    fn a_silenced_repeat_writes_no_line_at_any_level() {
        assert_eq!(logged_while(|| journal(Entry::Nothing)), "");
    }

    /// The whole of what an operator meets, end to end: a real refusal off a
    /// real socket, through the real transport, to the error text the sweep
    /// logs. The unit tests above prove the policy; this proves the endpoint,
    /// the status and the body are IN the subject that policy is keyed on.
    #[tokio::test]
    async fn a_refused_pull_names_the_endpoint_the_status_and_the_body() {
        let base = crate::transport::fake_core::serve_always(
            "500 Internal Server Error",
            r#"{"error":"provision rows could not be listed"}"#,
        )
        .await;
        let client = CoreClient::new(&base, "device-token");
        let err = pull_pending(&client).await.unwrap_err().to_string();
        assert!(
            err.contains(&format!("GET {base}/api/devices/me/provisions")),
            "{err}"
        );
        assert!(err.contains("500 Internal Server Error"), "{err}");
        assert!(
            err.contains(r#"{"error":"provision rows could not be listed"}"#),
            "{err}"
        );
    }

    /// The one this box actually met: Cloudflare's `520`, whose status line
    /// carries no reason at all. Before this change the whole journal entry
    /// was `provisions failed: 520 <unknown status code>`.
    #[tokio::test]
    async fn an_edge_refusal_with_no_reason_phrase_is_still_attributable() {
        let base = crate::transport::fake_core::serve_always(
            "520 ",
            "<html><head><title>520</title></head>\n<body>Web server is returning an unknown error</body></html>",
        )
        .await;
        let client = CoreClient::new(&base, "device-token");
        let err = pull_pending(&client).await.unwrap_err().to_string();
        assert!(err.contains("520"), "{err}");
        assert!(
            err.contains("Web server is returning an unknown error"),
            "{err}"
        );
        assert!(
            err.contains(&format!("GET {base}/api/devices/me/provisions")),
            "{err}"
        );
    }

    /// A pull that never got an answer at all. The endpoint is the one thing
    /// this box can still say, and it says it.
    #[tokio::test]
    async fn a_pull_that_reached_nobody_still_names_where_it_tried() {
        // Port 1 on loopback: bindable by root alone, so nothing answers here.
        let client = CoreClient::new("http://127.0.0.1:1", "device-token");
        let err = pull_pending(&client).await.unwrap_err().to_string();
        assert!(
            err.contains("GET http://127.0.0.1:1/api/devices/me/provisions"),
            "{err}"
        );
    }
}

