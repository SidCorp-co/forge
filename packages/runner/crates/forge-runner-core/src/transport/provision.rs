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
    /// Point git's credential helper at the repository's host: core mints a credential per ask,
    /// whichever source host it is (ISS-50).
    #[serde(default)]
    pub host_credential: bool,
    // cm:hack ISS-50 until:every core this runner pairs with sends hostCredential — a core released before ISS-50 sends only this name, with the same meaning
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
            .field("host_credential", &self.host_credential)
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
pub async fn pull_pending(client: &CoreClient) -> std::result::Result<Pending, PullRefusal> {
    let url = client.url("/api/devices/me/provisions");
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| PullRefusal::unanswered(&url, &format!("never got an answer: {e}")))?;
    let status = resp.status();
    // The status as `status::named` says it, and never as `StatusCode`'s own
    // `Display`: that prints `520 <unknown status code>` for the whole 52x
    // family the gateway in front of core answers with, which is the string
    // ISS-1233 was filed carrying. Read once here because both the refusal
    // below and the decode failure further down have to say it.
    let named = super::status::named(status.as_u16());
    if !status.is_success() {
        let body = match tokio::time::timeout(BODY_DEADLINE, resp.text()).await {
            Ok(Ok(raw)) => body_excerpt(&raw),
            Ok(Err(e)) => format!("<could not be read: {e}>"),
            Err(_) => format!("<not sent within {}s>", BODY_DEADLINE.as_secs()),
        };
        return Err(PullRefusal::answered(&url, &named, &body));
    }
    let reported = parse_failures(
        resp.headers()
            .get(FAILURES_HEADER)
            .and_then(|v| v.to_str().ok()),
    );
    let provisions = resp.json::<Vec<Provision>>().await.map_err(|e| {
        PullRefusal::unanswered(
            &url,
            &format!("answered {named} this box could not read: {e}"),
        )
    })?;
    let recovery = streak().succeeded(Instant::now());
    journal(recovery);
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

/// Consecutive refusals of ONE condition before it stops being a warning.
/// Chosen so a deploy window — a few polls of `503` while core restarts —
/// passes without an error, and a real outage does not.
const ESCALATE_AFTER: u32 = 5;

/// How long the body of an already-known refusal may take to arrive.
///
/// [`CoreClient`] builds its http client with no timeout, so a peer that sends
/// non-2xx headers and then stalls would hold this read open for as long as it
/// holds the socket. The refusal is known from the status line: reading the
/// body is diagnosis, and diagnosis must not be what stops the operator
/// hearing about the refusal at all.
const BODY_DEADLINE: Duration = Duration::from_secs(5);

/// Why one provision pull did not come back with rows, in the two halves the
/// journal needs it in.
///
/// `condition` is the stable half a streak is keyed on — the endpoint and the
/// status, or for a pull that got no answer, the endpoint and what went wrong.
/// `subject` is the whole line an operator reads, body included.
///
/// They are carried apart rather than encoded in one string and split back out
/// on a marker: `core_url` is configuration and can hold anything, so a base
/// URL containing that marker would have moved the split and collapsed two
/// conditions into one (review c8b010 F1). Nothing here can be broken by what
/// core sends or by what a person types into a config file.
#[derive(Debug, Clone)]
pub struct PullRefusal {
    condition: String,
    subject: String,
}

impl PullRefusal {
    /// A pull core answered, with a status this box will not accept.
    ///
    /// The body is NOT in the condition. Cloudflare's 5xx pages carry a Ray ID
    /// that changes every request, so a body-sensitive key would have made
    /// every poll of a `520` storm a brand-new condition and restored the very
    /// flood this change exists to stop. The cost is that two refusals sharing
    /// a status and differing only in body are one streak, so the second body
    /// is not written — the escalation carries the body of the refusal that
    /// escalated, which is the current one.
    /// `named` is the status as [`super::status::named`] says it, which is what
    /// makes one 52x code tell itself apart from the next.
    fn answered(url: &str, named: &str, body: &str) -> Self {
        let condition = format!("GET {url} answered {named}");
        Self {
            subject: format!("provisions failed: {condition}, body: {body}"),
            condition,
        }
    }

    /// A pull that produced no usable answer at all: nothing came back, or
    /// what came back could not be read as rows.
    fn unanswered(url: &str, what: &str) -> Self {
        let condition = format!("GET {url} {what}");
        Self {
            subject: format!("provisions failed: {condition}"),
            condition,
        }
    }
}

impl std::fmt::Display for PullRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.subject)
    }
}

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

/// Consecutive refusals of one condition.
///
/// A `502` from the edge and a `500` from a handler are different conditions
/// and each earns its own line — on this box they alternated for days behind
/// one indistinguishable warning. The body is carried on the line and not in
/// the key, for the reason [`condition`] gives.
#[derive(Debug, Default)]
struct Streak {
    condition: Option<String>,
    /// The most recent refusal whole, body included: what an escalation or a
    /// recovery names, so neither reports a count with nothing attached.
    subject: String,
    count: u32,
    first: Option<Instant>,
}

impl Streak {
    const fn new() -> Self {
        Self {
            condition: None,
            subject: String::new(),
            count: 0,
            first: None,
        }
    }

    /// Record one refusal and say what the journal owes for it.
    fn refused(&mut self, refusal: &PullRefusal, now: Instant) -> Entry {
        let same = self.condition.as_deref() == Some(refusal.condition.as_str());
        if same {
            self.count = self.count.saturating_add(1);
        } else {
            self.condition = Some(refusal.condition.clone());
            self.count = 1;
            self.first = Some(now);
        }
        self.subject = refusal.subject.clone();
        if !same {
            return Entry::Refused(refusal.subject.clone());
        }
        if self.count == ESCALATE_AFTER {
            return Entry::Escalated {
                subject: refusal.subject.clone(),
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
        let subject = std::mem::take(&mut self.subject);
        self.condition = None;
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
pub fn report_pull_refusal(e: &PullRefusal) {
    let entry = streak().refused(e, Instant::now());
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
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "provision-status",
            code,
            &text,
        )));
    }
    Ok(())
}
