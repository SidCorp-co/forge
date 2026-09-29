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

pub async fn project_core(pat: &CoreClient, project_id: &str) -> ProjectCore {
    let q = format!("/api/questions?projectId={project_id}&status=open&limit=20");
    let questions = get_json(pat, &q).await.and_then(|v| questions(&q, &v));
    let rows = format!("/api/projects/{project_id}/issues?status=awaiting_release&limit=50");
    let awaiting = match get_json(pat, &rows)
        .await
        .and_then(|v| awaiting_rows(&rows, &v))
    {
        Err(e) => Err(e),
        Ok((total, keys)) if total == 0 => Ok(AwaitingRelease {
            total,
            keys,
            blockers: Ok(Vec::new()),
        }),
        Ok((total, keys)) => {
            let r = format!("/api/projects/{project_id}/release-readiness");
            let blockers = get_json(pat, &r).await.and_then(|v| blockers(&r, &v));
            Ok(AwaitingRelease {
                total,
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

fn shape(route: &str, what: &str) -> Unreadable {
    Unreadable::new(
        format!("GET {route}"),
        format!("the answer carries no {what}"),
    )
}

pub fn questions(route: &str, v: &Value) -> Read<Questions> {
    let list = v["questions"]
        .as_array()
        .ok_or_else(|| shape(route, "`questions` list"))?;
    let listed = list
        .iter()
        .map(|q| Question {
            blocker_kind: q["blockerKind"].as_str().unwrap_or("unstated").to_string(),
            asked_ms: q["askedAt"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| q["createdAt"].as_str())
                .and_then(parse_utc_ms),
            prompt: q["prompt"]
                .as_str()
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
                .to_string(),
        })
        .collect::<Vec<_>>();
    let total = v["total"].as_u64().unwrap_or(listed.len() as u64);
    Ok(Questions { total, listed })
}

pub fn awaiting_rows(route: &str, v: &Value) -> Read<(u64, Vec<String>)> {
    let items = v["items"]
        .as_array()
        .ok_or_else(|| shape(route, "`items` list"))?;
    let keys = items
        .iter()
        .map(|i| i["displayId"].as_str().unwrap_or("?").to_string())
        .collect::<Vec<_>>();
    Ok((v["total"].as_u64().unwrap_or(keys.len() as u64), keys))
}

pub fn blockers(route: &str, v: &Value) -> Read<Vec<Blocker>> {
    let list = v["blockers"]
        .as_array()
        .ok_or_else(|| shape(route, "`blockers` list"))?;
    Ok(list
        .iter()
        .map(|b| Blocker {
            code: b["code"].as_str().unwrap_or("?").to_string(),
            message: b["message"].as_str().unwrap_or("").to_string(),
        })
        .collect())
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
        assert_eq!(q.total, 3);
        assert_eq!(q.listed[0].prompt, "Ship the migration?");
        assert_eq!(q.listed[0].blocker_kind, "human");
        assert_eq!(q.listed[0].asked_ms, parse_utc_ms("2026-09-30T01:30:00Z"));
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
            (1, vec!["ISS-7".to_string()])
        );
        let ready: Value = serde_json::from_str(
            r#"{"hasReleaseGate":false,"blockers":[{"code":"NO_RELEASE_GATE","httpStatus":409,"message":"This project has no release step","evaluated":true}],"warnings":[]}"#,
        )
        .unwrap();
        let b = blockers("/r", &ready).unwrap();
        assert_eq!(b[0].code, "NO_RELEASE_GATE");
        assert!(blockers("/r", &serde_json::json!({})).is_err());
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
