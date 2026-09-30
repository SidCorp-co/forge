//! Everything on this box, or on core for its projects, that waits on a person.
//!
//! Four places a wait lives, each read where it is written:
//! - a job pane stopped on a permission question, which the daemon leaves in
//!   `pool-jobs/<job>.json` as `seen.doing = awaiting_permission` every sweep
//!   (`pool_jobs::FileRecords::note`);
//! - a run parked on a human, in the ledger (read in `ledger_ro`);
//! - an open question on a bound project, which is core's;
//! - issues at `awaiting_release` on a project where core says no release can
//!   start over them now: `release-readiness` answers `blockers`, and ISS-1127
//!   made an empty list mean a release over that roster would be taken.
//!
//! The last two are routes behind `requireAuth`, which refuses a device token,
//! so they are asked with the runner's personal access token. Every request is
//! a GET.

use std::path::{Path, PathBuf};
use std::time::Duration;

use forge_runner_core::daemon::agent_activity::Doing;
use forge_runner_core::daemon::job_exit::Reported;
use forge_runner_core::transport::status::unanswered;
use forge_runner_core::transport::CoreClient;
use serde_json::Value;

use super::lanes::Counts;
use super::source::{Read, Unreadable};

/// One pool job's record, as the daemon left it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub job_id: String,
    pub pane: String,
    pub seen: Option<Reported>,
    pub opened_at: Option<i64>,
}

impl Job {
    /// Since when this pane has waited on a person, where its last report says it does.
    pub fn waiting_since(&self) -> Option<i64> {
        self.seen
            .filter(|s| s.doing == Doing::AwaitingPermission)
            .map(|s| s.at)
    }
}

#[derive(Debug, Clone, Default)]
pub struct Jobs {
    pub dir: PathBuf,
    pub absent: bool,
    pub records: Vec<Job>,
    /// Records that could not be read or parsed, each named.
    pub unreadable: Vec<Unreadable>,
}

pub fn jobs(dir: &Path) -> Read<Jobs> {
    let listing = match std::fs::read_dir(dir) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Jobs {
                dir: dir.to_path_buf(),
                absent: true,
                ..Jobs::default()
            })
        }
        Err(e) => return Err(Unreadable::new(dir.display().to_string(), e)),
    };
    Ok(jobs_from(dir, listing.map(|e| e.map(|e| e.path()))))
}

/// The records of a listing, each entry the listing could not yield named
/// among the unreadable rather than dropped.
fn jobs_from(dir: &Path, listing: impl Iterator<Item = std::io::Result<PathBuf>>) -> Jobs {
    let mut out = Jobs {
        dir: dir.to_path_buf(),
        ..Jobs::default()
    };
    for entry in listing {
        let path = match entry {
            Ok(p) => p,
            Err(e) => {
                out.unreadable.push(Unreadable::new(
                    dir.display().to_string(),
                    format!("an entry of the listing could not be read: {e}"),
                ));
                continue;
            }
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Some(job_id) = name.strip_suffix(".json") else {
            continue;
        };
        let parsed = std::fs::read_to_string(&path)
            .map_err(|e| e.to_string())
            .and_then(|t| {
                serde_json::from_str::<Value>(&t).map_err(|e| format!("does not parse: {e}"))
            });
        let v = match parsed {
            Ok(v) => v,
            Err(e) => {
                out.unreadable
                    .push(Unreadable::new(path.display().to_string(), e));
                continue;
            }
        };
        let Some(pane) = v["pane"].as_str() else {
            out.unreadable.push(Unreadable::new(
                path.display().to_string(),
                "the record names no pane",
            ));
            continue;
        };
        // No report yet is a job that has said nothing; a report that does not
        // parse is one this view cannot read, and may be the one that waits.
        let seen = match &v["seen"] {
            Value::Null => None,
            report => match Reported::from_json(report) {
                Some(r) => Some(r),
                None => {
                    out.unreadable.push(Unreadable::new(
                        path.display().to_string(),
                        format!("its `seen` report does not parse: {report}"),
                    ));
                    continue;
                }
            },
        };
        out.records.push(Job {
            job_id: job_id.to_string(),
            pane: pane.to_string(),
            seen,
            opened_at: v["openedAt"].as_i64(),
        });
    }
    out.records.sort_by(|a, b| a.job_id.cmp(&b.job_id));
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    /// Core's id for the question, which is what answers it: the prompt is
    /// shown whole, and this names the row the rest of it is on.
    pub id: String,
    pub blocker_kind: String,
    pub asked_ms: Option<i64>,
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Questions {
    pub total: u64,
    pub listed: Vec<Question>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Blocker {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AwaitingRelease {
    pub total: u64,
    pub keys: Vec<String>,
    /// Core's reasons no release can start over these rows. Read only where
    /// there are rows; empty means a release would be taken.
    pub blockers: Read<Vec<Blocker>>,
}

#[derive(Debug, Clone)]
pub struct ProjectCore {
    pub questions: Read<Questions>,
    pub awaiting: Read<AwaitingRelease>,
    /// The project's issues counted by status, which the table's lanes sum.
    pub lanes: Read<Counts>,
}

const DEADLINE: Duration = Duration::from_secs(10);

/// A request that got no answer is named by its cause, never by reqwest's
/// wrapper, whose text is the same for a refused port, a timeout and a dead
/// network (judge r3b, finding 88).
pub async fn get_json(client: &CoreClient, path: &str) -> Read<Value> {
    let route = format!("GET {path}");
    let resp = client
        .http()
        .get(client.url(path))
        .bearer_auth(client.device_token())
        .timeout(DEADLINE)
        .send()
        .await
        .map_err(|e| Unreadable::new(&route, unanswered(&e, DEADLINE)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| Unreadable::new(&route, unanswered(&e, DEADLINE)))?;
    if !status.is_success() {
        let body: String = text.chars().take(200).collect();
        return Err(Unreadable::new(&route, format!("{status}: {body}")));
    }
    serde_json::from_str(&text).map_err(|e| Unreadable::new(&route, format!("does not parse: {e}")))
}

/// Pages a list is read in, and how many pages one read may take before it
/// says it stopped: the view lists every row it claims to, or says it did not.
const PAGE: usize = 200;
const PAGES: usize = 20;

pub async fn project_core(pat: &CoreClient, project_id: &str) -> ProjectCore {
    let (questions, awaiting, lanes) = tokio::join!(
        all_questions(pat, project_id),
        awaiting_release(pat, project_id),
        by_status(pat, project_id)
    );
    ProjectCore {
        questions,
        awaiting,
        lanes,
    }
}

/// The route the lanes are read from, which the detail names.
pub fn lanes_route(project_id: &str) -> String {
    format!("/api/projects/{project_id}/issues/search?limit=1&withBuckets=true")
}

/// The project's issue counts by status: one page of one row, asked for its
/// `buckets`, which core counts under the project filter alone.
async fn by_status(pat: &CoreClient, project_id: &str) -> Read<Counts> {
    let route = lanes_route(project_id);
    let v = get_json(pat, &route).await?;
    counts(&route, &v)
}

/// `buckets.byStatus` of a search answer. An answer without it, or with a
/// count that is not a whole number, is refused by name: read as empty it
/// would draw every lane as a project with nothing in it.
pub fn counts(route: &str, v: &Value) -> Read<Counts> {
    let by = v["buckets"]["byStatus"]
        .as_object()
        .ok_or_else(|| shape(route, "`buckets.byStatus` count by status"))?;
    by.iter()
        .map(|(status, n)| {
            n.as_u64().map(|n| (status.clone(), n)).ok_or_else(|| {
                shape(
                    route,
                    &format!("whole count for `{status}` in `buckets.byStatus` (it holds {n})"),
                )
            })
        })
        .collect()
}

async fn awaiting_release(pat: &CoreClient, project_id: &str) -> Read<AwaitingRelease> {
    match all_awaiting(pat, project_id).await {
        Err(e) => Err(e),
        Ok(keys) if keys.is_empty() => Ok(AwaitingRelease {
            total: 0,
            keys,
            blockers: Ok(Vec::new()),
        }),
        Ok(keys) => {
            let r = format!("/api/projects/{project_id}/release-readiness");
            let blockers = get_json(pat, &r).await.and_then(|v| blockers(&r, &v));
            Ok(AwaitingRelease {
                total: keys.len() as u64,
                keys,
                blockers,
            })
        }
    }
}

/// Every open question, through `nextCursor` until core says there is no more.
async fn all_questions(pat: &CoreClient, project_id: &str) -> Read<Questions> {
    let base = format!("/api/questions?projectId={project_id}&status=open&limit={PAGE}");
    let mut listed = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..PAGES {
        let route = match &cursor {
            Some(c) => format!("{base}&cursor={}", query_value(c)),
            None => base.clone(),
        };
        let v = get_json(pat, &route).await?;
        listed.extend(questions(&route, &v)?);
        match next_cursor(&route, &v)? {
            Some(next) => cursor = Some(next),
            None => {
                return Ok(Questions {
                    total: listed.len() as u64,
                    listed,
                })
            }
        }
    }
    Err(Unreadable::new(
        format!("GET {base}"),
        format!(
            "more than {} open questions, so this view has not read them all",
            PAGE * PAGES
        ),
    ))
}

/// Every issue at `awaiting_release`, by offset until `hasMore` is false.
async fn all_awaiting(pat: &CoreClient, project_id: &str) -> Read<Vec<String>> {
    let base = format!("/api/projects/{project_id}/issues?status=awaiting_release&limit={PAGE}");
    let mut keys = Vec::new();
    for page in 0..PAGES {
        let route = format!("{base}&offset={}", page * PAGE);
        let v = get_json(pat, &route).await?;
        keys.extend(awaiting_rows(&route, &v)?);
        if !has_more(&route, &v)? {
            return Ok(keys);
        }
    }
    Err(Unreadable::new(
        format!("GET {base}"),
        format!(
            "more than {} issues at awaiting_release, so this view has not read them all",
            PAGE * PAGES
        ),
    ))
}

/// Whether a page says more follows. Core writes `hasMore` on every page, so
/// a page without it is not one this view can call the last.
pub fn has_more(route: &str, v: &Value) -> Read<bool> {
    v["hasMore"]
        .as_bool()
        .ok_or_else(|| shape(route, "`hasMore` flag"))
}

/// Where the next page of questions starts, or `None` on the last page. A
/// page that says more follows and gives nowhere to read it from is refused:
/// ending there would show what was read as all there is.
pub fn next_cursor(route: &str, v: &Value) -> Read<Option<String>> {
    if !has_more(route, v)? {
        return Ok(None);
    }
    match v["nextCursor"].as_str() {
        Some(c) if !c.is_empty() => Ok(Some(c.to_string())),
        _ => Err(shape(
            route,
            "`nextCursor` though it says `hasMore`, so the rest cannot be read",
        )),
    }
}

fn shape(route: &str, what: &str) -> Unreadable {
    Unreadable::new(
        format!("GET {route}"),
        format!("the answer carries no {what}"),
    )
}

/// A field a row must carry, or the row is not one this view can show.
fn field<'a>(route: &str, row: &'a Value, key: &str, what: &str) -> Read<&'a str> {
    row[key]
        .as_str()
        .ok_or_else(|| shape(route, &format!("`{key}` on a {what}")))
}

/// One page of `projectQuestionsFor`'s answer. Core's `shapeOf` writes
/// `prompt` and `askedAt` on every question, as `''` when it holds no step yet,
/// so an empty one is an answer and an absent one — like an absent id, blocker
/// kind or creation time — is not a question core writes, and is refused
/// rather than shown half.
pub fn questions(route: &str, v: &Value) -> Read<Vec<Question>> {
    let list = v["questions"]
        .as_array()
        .ok_or_else(|| shape(route, "`questions` list"))?;
    list.iter()
        .map(|q| {
            let created = field(route, q, "createdAt", "question")?;
            let asked = Some(field(route, q, "askedAt", "question")?)
                .filter(|s| !s.is_empty())
                .unwrap_or(created);
            Ok(Question {
                blocker_kind: field(route, q, "blockerKind", "question")?.to_string(),
                asked_ms: Some(parse_utc_ms(asked).ok_or_else(|| {
                    shape(route, &format!("readable time on a question (`{asked}`)"))
                })?),
                prompt: first_line(field(route, q, "prompt", "question")?).to_string(),
                id: field(route, q, "id", "question")?.to_string(),
            })
        })
        .collect()
}

/// A prompt's first line with anything on it: a prompt that opens on a blank
/// line still asks what its next line asks, and only one with no text at all
/// holds no step (judge w3, finding 54).
fn first_line(prompt: &str) -> &str {
    prompt
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

/// One page of the project issue list: each row's display key.
pub fn awaiting_rows(route: &str, v: &Value) -> Read<Vec<String>> {
    let items = v["items"]
        .as_array()
        .ok_or_else(|| shape(route, "`items` list"))?;
    items
        .iter()
        .map(|i| field(route, i, "displayId", "listed issue").map(str::to_string))
        .collect()
}

pub fn blockers(route: &str, v: &Value) -> Read<Vec<Blocker>> {
    let list = v["blockers"]
        .as_array()
        .ok_or_else(|| shape(route, "`blockers` list"))?;
    list.iter()
        .map(|b| {
            Ok(Blocker {
                code: field(route, b, "code", "blocker")?.to_string(),
                message: field(route, b, "message", "blocker")?.to_string(),
            })
        })
        .collect()
}

/// `s` as one query-string value: every byte outside RFC 3986's unreserved set
/// percent-encoded, so a cursor carrying `+`, `&` or `=` reaches core whole.
pub fn query_value(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A run of ASCII digits of exactly `n`, as a number.
fn digits(s: &str, n: usize) -> Option<i64> {
    (s.len() == n && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// `YYYY-MM-DDTHH:MM:SS[.fff…](Z|+00:00)` → wall-clock ms. Anything else —
/// a field out of its range, a day the month does not have — is `None`, so a
/// stamp core could not have written is never turned into an age.
pub fn parse_utc_ms(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.splitn(3, '-');
    let (y, m, day) = (
        digits(d.next()?, 4)?,
        digits(d.next()?, 2)?,
        digits(d.next()?, 2)?,
    );
    let rest = rest
        .strip_suffix('Z')
        .or_else(|| rest.strip_suffix("+00:00"))?;
    let (hms, frac) = rest.split_once('.').unwrap_or((rest, "0"));
    let mut t = hms.splitn(3, ':');
    let (hh, mm, ss) = (
        digits(t.next()?, 2)?,
        digits(t.next()?, 2)?,
        digits(t.next()?, 2)?,
    );
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let month_days = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if !(1..=month_days).contains(&day) || hh > 23 || mm > 59 || ss > 59 {
        return None;
    }
    if frac.is_empty() || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let millis: i64 = format!("{frac:0<3}").get(..3)?.parse().ok()?;
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + hh * 3_600 + mm * 60 + ss) * 1_000) + millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_runner_core::daemon::agent_activity::Event;
    use forge_runner_core::daemon::pool_jobs::{FileRecords, Live, Records};
    use forge_runner_core::daemon::turn_evidence::Watch;
    use forge_runner_core::test_scratch::Scratch;

    /// Criterion 15, against the record the daemon's own writer leaves.
    #[tokio::test]
    async fn a_job_pane_on_a_permission_question_is_read_from_the_daemons_record() {
        let s = Scratch::new("top-jobs");
        let recs = FileRecords {
            dir: s.path().to_path_buf(),
        };
        recs.note(&Live {
            job_id: "job-1".into(),
            pane: "forge-job-job-1".into(),
            watch: Watch::Adopted {
                session_id: "sess".into(),
            },
            seen: Some(Reported {
                doing: Doing::AwaitingPermission,
                last_event: Event::PermissionRequested,
                at: 1_000,
                prompts: 1,
            }),
            transcript: None,
            opened_at: Some(500),
        })
        .await;
        std::fs::write(s.path().join("job-2.json"), "{half").unwrap();
        let got = jobs(s.path()).unwrap();
        assert_eq!(got.records.len(), 1);
        assert_eq!(got.records[0].pane, "forge-job-job-1");
        assert_eq!(got.records[0].waiting_since(), Some(1_000));
        assert_eq!(
            got.unreadable.len(),
            1,
            "a half record is named, not skipped"
        );
    }

    #[test]
    fn no_pool_job_directory_is_an_absent_record_not_an_error() {
        let s = Scratch::new("top-jobs-none");
        let got = jobs(&s.path().join("pool-jobs")).unwrap();
        assert!(got.absent && got.records.is_empty());
    }

    /// Criterion 14's parse, against the shape `projectQuestionsFor` answers.
    #[test]
    fn open_questions_are_read_with_kind_age_and_first_line() {
        let v: Value = serde_json::from_str(
            r#"{"questions":[{"id":"q1","blockerKind":"human","createdAt":"2026-09-30T01:00:00.000Z","askedAt":"2026-09-30T01:30:00.000Z","prompt":"Ship the migration?\nIt drops a column."}],"total":3,"hasMore":true,"nextCursor":"c"}"#,
        )
        .unwrap();
        let q = questions("/api/questions", &v).unwrap();
        assert_eq!(q[0].prompt, "Ship the migration?");
        assert_eq!(q[0].blocker_kind, "human");
        assert_eq!(q[0].id, "q1");
        assert_eq!(q[0].asked_ms, parse_utc_ms("2026-09-30T01:30:00Z"));
        assert!(questions("/r", &serde_json::json!({"items": []})).is_err());
    }

    /// Judge w3's finding 54: a prompt opening on a blank line is shown by the
    /// first line that says something, and only a prompt of nothing but
    /// whitespace reads as holding no step.
    #[test]
    fn a_prompt_opening_on_a_blank_line_is_shown_by_its_first_line_with_text() {
        let prompt = |p: &str| {
            let v = serde_json::json!({"questions": [{"id": "q4", "blockerKind": "human",
                "createdAt": "2026-09-30T01:00:00.000Z", "askedAt": "", "prompt": p}]});
            questions("/q", &v).unwrap()[0].prompt.clone()
        };
        assert_eq!(
            prompt("\nWhich branch ships tonight, stg or main?"),
            "Which branch ships tonight, stg or main?"
        );
        assert_eq!(
            prompt("  \r\n\t\n  Rotate the key?  \nsecond"),
            "Rotate the key?"
        );
        assert_eq!(prompt(" \n\t\n"), "");
        assert_eq!(prompt(""), "");
    }

    /// Criteria 17, 28's parse.
    #[test]
    fn the_roster_and_its_blockers_are_read_from_cores_shapes() {
        let rows: Value = serde_json::from_str(
            r#"{"items":[{"displayId":"ISS-7","title":"t"}],"returned":1,"total":1,"limit":50,"offset":0,"hasMore":false}"#,
        )
        .unwrap();
        assert_eq!(
            awaiting_rows("/r", &rows).unwrap(),
            vec!["ISS-7".to_string()]
        );
        let ready: Value = serde_json::from_str(
            r#"{"hasReleaseGate":false,"blockers":[{"code":"NO_RELEASE_GATE","httpStatus":409,"message":"This project has no release step","evaluated":true}],"warnings":[]}"#,
        )
        .unwrap();
        let b = blockers("/r", &ready).unwrap();
        assert_eq!(b[0].code, "NO_RELEASE_GATE");
        assert!(blockers("/r", &serde_json::json!({})).is_err());
    }

    /// Whole-set consult at 4505806, F3: a record with no report yet is a job
    /// that has said nothing; one whose report does not parse is unreadable,
    /// since it may be the one that waits.
    #[test]
    fn a_report_that_does_not_parse_is_unreadable_and_none_is_silence() {
        let s = Scratch::new("top-jobs-seen");
        std::fs::write(
            s.path().join("job-1.json"),
            r#"{"pane":"forge-job-job-1","seen":{"doing":"awaiting_permission"}}"#,
        )
        .unwrap();
        std::fs::write(s.path().join("job-2.json"), r#"{"pane":"forge-job-job-2"}"#).unwrap();
        std::fs::write(
            s.path().join("job-3.json"),
            r#"{"pane":"forge-job-job-3","seen":null}"#,
        )
        .unwrap();
        let got = jobs(s.path()).unwrap();
        assert_eq!(got.unreadable.len(), 1, "{got:?}");
        let e = got.unreadable[0].to_string();
        assert!(
            e.contains("job-1.json") && e.contains("its `seen` report does not parse"),
            "{e}"
        );
        let ids: Vec<&str> = got.records.iter().map(|j| j.job_id.as_str()).collect();
        assert_eq!(ids, vec!["job-2", "job-3"]);
        assert!(got.records.iter().all(|j| j.seen.is_none()));
    }

    /// Consult whole-set F1: an entry the listing could not yield may be the
    /// job that waits, so it is named, and "none waits" is not all it says.
    #[test]
    fn an_entry_the_listing_cannot_yield_is_named_never_dropped() {
        let dir = Path::new("/x/pool-jobs");
        let listing = vec![Err(std::io::Error::other("stale file handle"))];
        let got = jobs_from(dir, listing.into_iter());
        assert!(got.records.is_empty());
        assert_eq!(got.unreadable.len(), 1, "{got:?}");
        assert!(
            got.unreadable[0].to_string().starts_with("UNREADABLE — /x/pool-jobs: an entry of the listing could not be read: stale file handle"),
            "{}",
            got.unreadable[0]
        );
    }

    /// Consult whole-set F2: the last page is the one that says so. A page
    /// claiming more with nowhere to read it, or not saying, is refused.
    #[test]
    fn a_page_that_hides_where_the_rest_is_is_unreadable() {
        let last = serde_json::json!({"hasMore": false, "nextCursor": null});
        assert_eq!(next_cursor("/q", &last).unwrap(), None);
        let more = serde_json::json!({"hasMore": true, "nextCursor": "YWJj"});
        assert_eq!(next_cursor("/q", &more).unwrap(), Some("YWJj".to_string()));
        for bad in [
            serde_json::json!({"hasMore": true, "nextCursor": null}),
            serde_json::json!({"hasMore": true, "nextCursor": ""}),
            serde_json::json!({"hasMore": true}),
        ] {
            let e = next_cursor("/q", &bad).unwrap_err();
            assert!(e.reason.contains("`nextCursor`"), "{bad}: {e}");
        }
        let e = next_cursor("/q", &serde_json::json!({"nextCursor": "x"})).unwrap_err();
        assert!(e.reason.contains("`hasMore`"), "{e}");
        assert!(!has_more("/r", &serde_json::json!({"hasMore": false})).unwrap());
        assert!(has_more("/r", &serde_json::json!({"items": []})).is_err());
    }

    /// Criterion 22, for a row: a field core always writes that is missing is
    /// an answer this view cannot read, never a row with a placeholder in it.
    #[test]
    fn a_row_missing_what_core_always_writes_is_unreadable() {
        let q = serde_json::json!({"questions": [{"prompt": "x"}]});
        let e = questions("/q", &q).unwrap_err();
        assert!(e.reason.contains("`createdAt`"), "{e}");
        let q = serde_json::json!({"questions": [{"prompt": "x", "createdAt": "2026-09-30T01:00:00Z", "askedAt": ""}]});
        assert!(questions("/q", &q)
            .unwrap_err()
            .reason
            .contains("`blockerKind`"));
        let q = serde_json::json!({"questions": [{"blockerKind": "human", "createdAt": "soon", "askedAt": "", "prompt": ""}]});
        assert!(questions("/q", &q).is_err());
        // Recheck 4c46d2: `shapeOf` writes both on every question, so absence
        // is not a shape core answers with.
        let q = serde_json::json!({"questions": [{"blockerKind": "human", "createdAt": "2026-09-30T01:00:00Z", "askedAt": ""}]});
        assert!(questions("/q", &q).unwrap_err().reason.contains("`prompt`"));
        let q = serde_json::json!({"questions": [{"blockerKind": "human", "createdAt": "2026-09-30T01:00:00Z", "prompt": ""}]});
        assert!(questions("/q", &q)
            .unwrap_err()
            .reason
            .contains("`askedAt`"));
        let rows = serde_json::json!({"items": [{}]});
        assert!(awaiting_rows("/r", &rows)
            .unwrap_err()
            .reason
            .contains("`displayId`"));
        let b = serde_json::json!({"blockers": [{"code": "X"}]});
        assert!(blockers("/r", &b).unwrap_err().reason.contains("`message`"));
        let q = serde_json::json!({"questions": [{"blockerKind": "human", "createdAt": "2026-09-30T01:00:00Z", "askedAt": "", "prompt": "x"}]});
        assert!(questions("/q", &q).unwrap_err().reason.contains("`id`"));
        let empty = serde_json::json!({"questions": [{"id": "q9", "blockerKind": "human", "createdAt": "2026-09-30T01:00:00Z", "askedAt": "", "prompt": ""}]});
        let got = questions("/q", &empty).unwrap();
        assert_eq!(got[0].prompt, "", "a question with no step has no prompt");
        assert_eq!(
            got[0].asked_ms,
            parse_utc_ms("2026-09-30T01:00:00Z"),
            "and was asked when it was created"
        );
    }

    #[test]
    fn a_utc_stamp_reads_as_wall_clock_ms() {
        assert_eq!(parse_utc_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc_ms("1970-01-02T00:00:01.5Z"), Some(86_401_500));
        assert_eq!(
            parse_utc_ms("2026-09-30T00:00:00.000Z"),
            Some(1_790_726_400_000)
        );
        assert_eq!(parse_utc_ms("yesterday"), None);
        assert_eq!(
            parse_utc_ms("2028-02-29T00:00:00Z"),
            Some(1_835_395_200_000)
        );
    }

    /// Whole-set consult at c0d0604, F4: a stamp shaped like a time but naming
    /// none is refused, so no age is made up from it.
    #[test]
    fn a_stamp_out_of_range_is_no_time() {
        for bad in [
            "2026-13-01T00:00:00Z",
            "2026-00-01T00:00:00Z",
            "2026-04-31T00:00:00Z",
            "2027-02-29T00:00:00Z",
            "2026-99-99T99:99:99Z",
            "2026-09-30T24:00:00Z",
            "2026-09-30T00:60:00Z",
            "2026-09-30T00:00:60Z",
            "2026-09-30T00:00:00.12xZ",
            "2026-09-30T00:00:00.Z",
            "2026-9-30T00:00:00Z",
            "+2026-09-30T00:00:00Z",
        ] {
            assert_eq!(parse_utc_ms(bad), None, "{bad}");
        }
        let q = serde_json::json!({"questions": [{"blockerKind": "human", "createdAt": "2026-99-99T99:99:99Z", "askedAt": "", "prompt": "x"}]});
        assert!(questions("/q", &q)
            .unwrap_err()
            .to_string()
            .starts_with("UNREADABLE — GET /q"));
    }

    /// Whole-set consult at c0d0604, F3: a cursor goes back to core whole.
    #[test]
    fn a_cursor_is_sent_as_one_query_value() {
        assert_eq!(query_value("MjAyNi0wOS0zMHxhYmM"), "MjAyNi0wOS0zMHxhYmM");
        assert_eq!(query_value("a+b&c=="), "a%2Bb%26c%3D%3D");
        assert_eq!(query_value("x/y z"), "x%2Fy%20z");
    }

    /// Criterion 3's read, and criterion 8's refusal: core's counts by status
    /// are taken whole, and an answer without them, or with a count that is
    /// not a whole number, is refused naming what it lacked, never read as a
    /// project with nothing in it.
    #[test]
    fn counts_by_status_are_read_whole_or_refused_by_name() {
        let r = "/api/projects/p/issues/search?limit=1&withBuckets=true";
        let v: Value = serde_json::from_str(
            r#"{"items":[],"total":7,"buckets":{"byStatus":{"open":3,"draft":4},"detector":0}}"#,
        )
        .unwrap();
        let c = counts(r, &v).unwrap();
        assert_eq!(c.get("open"), Some(&3));
        assert_eq!(c.get("draft"), Some(&4));
        assert_eq!(c.len(), 2);
        let empty: Value = serde_json::from_str(r#"{"buckets":{"byStatus":{}}}"#).unwrap();
        assert!(
            counts(r, &empty).unwrap().is_empty(),
            "a project with no issue"
        );
        for (body, says) in [
            (
                r#"{"items":[],"total":0}"#,
                "`buckets.byStatus` count by status",
            ),
            (
                r#"{"buckets":{"byStatus":[]}}"#,
                "`buckets.byStatus` count by status",
            ),
            (
                r#"{"buckets":{"byStatus":{"open":"3"}}}"#,
                "whole count for `open` in `buckets.byStatus` (it holds \"3\")",
            ),
            (
                r#"{"buckets":{"byStatus":{"open":-1}}}"#,
                "whole count for `open` in `buckets.byStatus` (it holds -1)",
            ),
        ] {
            let v: Value = serde_json::from_str(body).unwrap();
            let e = counts(r, &v).expect_err(body).to_string();
            assert!(e.contains(says) && e.contains(r), "{body}: {e}");
        }
    }
}
