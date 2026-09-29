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
use forge_runner_core::transport::CoreClient;
use serde_json::Value;

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
    let mut out = Jobs {
        dir: dir.to_path_buf(),
        ..Jobs::default()
    };
    for entry in listing.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(job_id) = name.strip_suffix(".json") else {
            continue;
        };
        let path = entry.path();
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
        out.records.push(Job {
            job_id: job_id.to_string(),
            pane: pane.to_string(),
            seen: Reported::from_json(&v["seen"]),
            opened_at: v["openedAt"].as_i64(),
        });
    }
    out.records.sort_by(|a, b| a.job_id.cmp(&b.job_id));
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
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
}

const DEADLINE: Duration = Duration::from_secs(10);

pub async fn get_json(client: &CoreClient, path: &str) -> Read<Value> {
    let route = format!("GET {path}");
    let resp = client
        .http()
        .get(client.url(path))
        .bearer_auth(client.device_token())
        .timeout(DEADLINE)
        .send()
        .await
        .map_err(|e| Unreadable::new(&route, e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| Unreadable::new(&route, e))?;
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
    let questions = all_questions(pat, project_id).await;
    let awaiting = match all_awaiting(pat, project_id).await {
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
    };
    ProjectCore {
        questions,
        awaiting,
    }
}

/// Every open question, through `nextCursor` until core says there is no more.
async fn all_questions(pat: &CoreClient, project_id: &str) -> Read<Questions> {
    let base = format!("/api/questions?projectId={project_id}&status=open&limit={PAGE}");
    let mut listed = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..PAGES {
        let route = match &cursor {
            Some(c) => format!("{base}&cursor={c}"),
            None => base.clone(),
        };
        let v = get_json(pat, &route).await?;
        listed.extend(questions(&route, &v)?);
        match v["nextCursor"].as_str() {
            Some(next) if v["hasMore"].as_bool() == Some(true) => cursor = Some(next.to_string()),
            _ => {
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
        if v["hasMore"].as_bool() != Some(true) {
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
/// so an empty one is an answer and an absent one — like an absent blocker kind
/// or creation time — is not a question core writes, and is refused rather
/// than shown half.
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
                prompt: field(route, q, "prompt", "question")?
                    .lines()
                    .next()
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
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

/// `YYYY-MM-DDTHH:MM:SS[.fff](Z|+00:00)` → wall-clock ms. Anything else is `None`.
pub fn parse_utc_ms(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, m, day) = (d.next()??, d.next()??, d.next()??);
    let rest = rest
        .strip_suffix('Z')
        .or_else(|| rest.strip_suffix("+00:00"))?;
    let (hms, frac) = rest.split_once('.').unwrap_or((rest, "0"));
    let mut t = hms.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (hh, mm, ss) = (t.next()??, t.next()??, t.next()??);
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
        assert_eq!(q[0].asked_ms, parse_utc_ms("2026-09-30T01:30:00Z"));
        assert!(questions("/r", &serde_json::json!({"items": []})).is_err());
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
        let empty = serde_json::json!({"questions": [{"blockerKind": "human", "createdAt": "2026-09-30T01:00:00Z", "askedAt": "", "prompt": ""}]});
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
    }
}
