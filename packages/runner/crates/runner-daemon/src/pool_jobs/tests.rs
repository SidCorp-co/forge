use super::*;

/// A pool holding one claimable job, which records every session it is asked
/// to prepare under and refuses each preparation.
struct OneJob {
    prepared_under: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl Pool for OneJob {
    async fn claimable(
        &self,
        _project_id: &str,
    ) -> std::result::Result<Vec<PoolEntry>, ReadFailure> {
        Ok(vec![PoolEntry {
            job_id: "job-1".into(),
            job_type: "release".into(),
            issue_id: None,
            issue_key: None,
            age_minutes: 0.0,
            attempts: 0,
            held_by: None,
        }])
    }
    async fn prepare(&self, _job_id: &str, session_id: &str) -> Result<Prepared> {
        self.prepared_under
            .lock()
            .unwrap()
            .push(session_id.to_string());
        Ok(Prepared::Refused(pool::Refusal::AlreadyHeld))
    }
    async fn start(&self, _job_id: &str, _session_id: &str) -> Result<Started> {
        unreachable!("nothing is started from a refused preparation")
    }
    async fn release(&self, _job_id: &str, _session_id: &str) -> Result<()> {
        unreachable!("nothing is held from a refused preparation")
    }
    async fn mcp_servers(&self, _project_id: &str) -> Result<ProjectMcpServers> {
        unreachable!("no pane is opened from a refused preparation")
    }
    async fn box_pat_reach(&self, _project_id: &str) -> BoxPatReach {
        unreachable!("no credential is asked about from a refused preparation")
    }
}

struct NoPanes;

#[async_trait::async_trait]
impl Panes for NoPanes {
    async fn open(
        &self,
        _name: &str,
        _cwd: &Path,
        _prompt: &str,
        _env: &[(String, String)],
        _launch: &Launch<'_>,
    ) -> Result<()> {
        unreachable!()
    }
    async fn released(&self, _name: &str) {}
    async fn gone(&self, _name: &str) -> bool {
        true
    }
    async fn kill(&self, _name: &str) -> Result<()> {
        unreachable!()
    }
    async fn names(&self) -> Vec<String> {
        Vec::new()
    }
    async fn send_line(
        &self,
        _name: &str,
        _text: &str,
    ) -> std::result::Result<terminal::Prompt, terminal::NotTyped> {
        unreachable!()
    }
}

struct NoReport;

#[async_trait::async_trait]
impl Report for NoReport {
    async fn ack(&self, _job_id: &str) -> Result<()> {
        unreachable!()
    }
    async fn progress(&self, _job_id: &str, _runtime_state: Option<&str>) -> Result<Standing> {
        unreachable!()
    }
    async fn fail(&self, _job_id: &str, _error: &str) -> Result<bool> {
        unreachable!()
    }
    async fn kill_ack(&self, _job_id: &str, _outcome: &str) -> Result<()> {
        unreachable!()
    }
}

async fn take(pool: &OneJob, master_session: Option<&str>) -> Took {
    take_one(
        &JobPorts {
            pool,
            panes: &NoPanes,
            report: &NoReport,
            records: &NoRecords,
        },
        &JobPanes::new(),
        ServedProject {
            id: "project-1",
            slug: "p1",
        },
        master_session,
        4,
        None,
    )
    .await
}

#[tokio::test]
async fn a_project_with_no_master_session_asks_core_to_prepare_nothing() {
    let pool = OneJob {
        prepared_under: Mutex::new(Vec::new()),
    };
    let took = take(&pool, None).await;
    assert!(matches!(took, Took::NoMasterSession(ref job) if job == "job-1"));
    assert!(pool.prepared_under.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_job_is_prepared_under_the_master_session_core_issued() {
    let pool = OneJob {
        prepared_under: Mutex::new(Vec::new()),
    };
    let took = take(&pool, Some("master-1")).await;
    assert!(matches!(took, Took::Refused(_)));
    assert_eq!(*pool.prepared_under.lock().unwrap(), vec!["master-1"]);
}

#[test]
fn the_missing_master_session_is_said_on_its_edges() {
    let panes = JobPanes::new();
    assert!(panes.note_master_session("p", false));
    assert!(!panes.note_master_session("p", false));
    assert!(panes.note_master_session("p", true));
    assert!(!panes.note_master_session("p", true));
}

#[test]
fn a_job_pane_keeps_its_own_projects_master_and_an_adopted_one_keeps_every_master() {
    let panes = JobPanes::new();
    panes.hold("job-a", "forge-job-a", Watch::Unhooked, None, None, None);
    panes.note_project("job-a", "project-1");
    assert_eq!(panes.holds_for("project-1"), 1);
    assert_eq!(panes.holds_for("project-2"), 0);

    panes.hold("job-b", "forge-job-b", Watch::Unhooked, None, None, None);
    assert_eq!(
        panes.holds_for("project-2"),
        1,
        "a project never learned is counted for all"
    );

    panes.forget("job-a");
    panes.forget("job-b");
    assert_eq!(panes.holds_for("project-1"), 0);
}

#[test]
fn a_job_pane_denies_every_tool_that_waits_on_a_person_and_a_master_pane_none() {
    use runner_workspace::terminal::{job_argv, pane_argv};
    let policy = vec![
        "Bash(git push:*)".to_string(),
        "AskUserQuestion".to_string(),
    ];
    let denied = ports::job_denied_tools(&policy);
    for tool in ports::JOB_PANE_DENIED {
        assert_eq!(
            denied.iter().filter(|t| *t == tool).count(),
            1,
            "{denied:?}"
        );
    }
    assert!(denied.contains(&"Bash(git push:*)".to_string()));
    let job = job_argv(None, None, None, &ports::job_denied_tools(&[]), None).join(" ");
    assert!(
        job.contains("--disallowed-tools 'AskUserQuestion'"),
        "{job}"
    );
    assert!(!pane_argv(None, None)
        .join(" ")
        .contains("--disallowed-tools"));
}

#[test]
fn a_job_brief_is_the_launch_prompt_after_the_variadic_tool_list_and_a_master_pane_has_none() {
    use runner_workspace::terminal::{job_argv, pane_argv};
    let brief = std::path::Path::new("/box/forge-job-mcp-x.brief.md");
    let line = job_argv(None, None, None, &ports::job_denied_tools(&[]), Some(brief))
        .pop()
        .unwrap();
    assert!(
        line.starts_with("p=$(cat -- '/box/forge-job-mcp-x.brief.md')"),
        "{line}"
    );
    assert!(line.ends_with("'ExitPlanMode' -- \"$p\""), "{line}");
    assert!(!pane_argv(None, None).join(" ").contains("$p"));
}

#[test]
fn a_stored_token_fenced_away_from_the_project_or_not_taken_is_refused_by_name() {
    let fenced = r#"{"code":"PAT_PROJECT_OUTSIDE_FENCE","message":"PAT_PROJECT_OUTSIDE_FENCE: this request came on token \"dev-runner-box\", which reaches forge"}"#;
    assert_eq!(
        reach_of(403, fenced),
        BoxPatReach::Refused {
            code: PAT_PROJECT_OUTSIDE_FENCE.into(),
            detail: "PAT_PROJECT_OUTSIDE_FENCE: this request came on token \"dev-runner-box\", which reaches forge".into(),
        }
    );
    assert!(
        matches!(reach_of(401, "{}"), BoxPatReach::Refused { ref code, .. } if code == "UNAUTHORIZED")
    );
    assert_eq!(reach_of(200, "{}"), BoxPatReach::Reaches);
    // a refusal that is not the credential's, and a core that did not answer, conclude nothing
    assert!(matches!(
        reach_of(403, r#"{"code":"FORBIDDEN"}"#),
        BoxPatReach::Unread(_)
    ));
    assert!(matches!(
        reach_of(502, "bad gateway"),
        BoxPatReach::Unread(_)
    ));
}

/// A pool holding one job the box prepares, whose stored token is refused on the project.
struct FencedJob {
    reach: BoxPatReach,
    started: Mutex<u32>,
}

#[async_trait::async_trait]
impl Pool for FencedJob {
    async fn claimable(
        &self,
        _project_id: &str,
    ) -> std::result::Result<Vec<PoolEntry>, ReadFailure> {
        Ok(vec![PoolEntry {
            job_id: "job-2".into(),
            job_type: "release_batch".into(),
            issue_id: None,
            issue_key: None,
            age_minutes: 0.0,
            attempts: 0,
            held_by: None,
        }])
    }
    async fn prepare(&self, _job_id: &str, _session_id: &str) -> Result<Prepared> {
        let cwd = std::env::temp_dir();
        Ok(Prepared::Took(Box::new(
            serde_json::from_value(serde_json::json!({
                "jobId": "job-2",
                "type": "release_batch",
                "agentSessionId": "sess-2",
                "repoPath": cwd.to_string_lossy(),
                "promptString": "release it",
            }))
            .expect("a prepared job"),
        )))
    }
    async fn start(&self, _job_id: &str, _session_id: &str) -> Result<Started> {
        *self.started.lock().unwrap() += 1;
        Ok(Started::Ok)
    }
    async fn release(&self, _job_id: &str, _session_id: &str) -> Result<()> {
        unreachable!("a refused job is failed by name, never given back to be claimed again")
    }
    async fn mcp_servers(&self, _project_id: &str) -> Result<ProjectMcpServers> {
        Ok(ProjectMcpServers::default())
    }
    async fn box_pat_reach(&self, _project_id: &str) -> BoxPatReach {
        self.reach.clone()
    }
}

/// A report that keeps every failure it is told.
#[derive(Default)]
struct Failures(Mutex<Vec<(String, String)>>);

#[async_trait::async_trait]
impl Report for Failures {
    async fn ack(&self, _job_id: &str) -> Result<()> {
        Ok(())
    }
    async fn progress(&self, _job_id: &str, _runtime_state: Option<&str>) -> Result<Standing> {
        Ok(Standing::Ours)
    }
    async fn fail(&self, job_id: &str, error: &str) -> Result<bool> {
        self.0.lock().unwrap().push((job_id.into(), error.into()));
        Ok(true)
    }
    async fn kill_ack(&self, _job_id: &str, _outcome: &str) -> Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn a_job_whose_pane_could_reach_nothing_is_failed_by_name_and_no_pane_opens() {
    let pool = FencedJob {
        reach: BoxPatReach::Refused {
            code: PAT_PROJECT_OUTSIDE_FENCE.into(),
            detail:
                "this request came on token \"dev-runner-box\", which reaches forge, hop, autoflow"
                    .into(),
        },
        started: Mutex::new(0),
    };
    let report = Failures::default();
    let registry = JobPanes::new();
    let took = take_one(
        &JobPorts {
            pool: &pool,
            panes: &NoPanes,
            report: &report,
            records: &NoRecords,
        },
        &registry,
        ServedProject {
            id: "a417a126",
            slug: "no-such-checkout-slug",
        },
        Some("master-1"),
        4,
        None,
    )
    .await;
    assert_eq!(took, Took::Refused(PAT_PROJECT_OUTSIDE_FENCE.into()));
    assert_eq!(*pool.started.lock().unwrap(), 1);
    assert_eq!(
        registry.count(),
        0,
        "no slot is held for a pane that never opened"
    );
    let failed = report.0.lock().unwrap().clone();
    assert_eq!(failed.len(), 1);
    assert_eq!(failed[0].0, "job-2");
    assert!(
        failed[0]
            .1
            .starts_with("[CREDENTIAL_REFUSED] PAT_PROJECT_OUTSIDE_FENCE:"),
        "{}",
        failed[0].1
    );
    assert!(
        failed[0]
            .1
            .contains("no checkout credential for no-such-checkout-slug"),
        "{}",
        failed[0].1
    );
}

/// Panes that are all alive and close when asked.
struct LivePanes(Mutex<Vec<String>>);

#[async_trait::async_trait]
impl Panes for LivePanes {
    async fn open(
        &self,
        _name: &str,
        _cwd: &Path,
        _prompt: &str,
        _env: &[(String, String)],
        _launch: &Launch<'_>,
    ) -> Result<()> {
        unreachable!()
    }
    async fn released(&self, _name: &str) {}
    async fn gone(&self, _name: &str) -> bool {
        false
    }
    async fn kill(&self, name: &str) -> Result<()> {
        self.0.lock().unwrap().push(name.into());
        Ok(())
    }
    async fn names(&self) -> Vec<String> {
        Vec::new()
    }
    async fn send_line(
        &self,
        _name: &str,
        _text: &str,
    ) -> std::result::Result<terminal::Prompt, terminal::NotTyped> {
        unreachable!()
    }
}

#[tokio::test]
async fn a_pane_its_own_project_refused_ends_on_that_refusal_at_once_not_on_its_silence() {
    let registry = JobPanes::new();
    let watch = Watch::Hooked {
        session_id: "sess-3".into(),
        delivered_at: now_ms(),
    };
    registry.hold("job-3", "forge-job-3", watch, None, None, Some(now_ms()));
    let activity = Activities::new();
    activity.refuse(
        "sess-3",
        runner_core::agent_activity::Refused {
            code: PAT_PROJECT_OUTSIDE_FENCE.into(),
            detail: "reaches forge, hop, autoflow".into(),
            at: now_ms(),
        },
    );
    let panes = LivePanes(Mutex::new(Vec::new()));
    let report = Failures::default();
    supervise(&panes, &report, &NoRecords, &registry, &activity).await;
    let failed = report.0.lock().unwrap().clone();
    assert_eq!(failed.len(), 1, "{failed:?}");
    assert!(
        failed[0]
            .1
            .starts_with("[CREDENTIAL_REFUSED] PAT_PROJECT_OUTSIDE_FENCE:"),
        "{}",
        failed[0].1
    );
    assert!(failed[0].1.contains("reaches forge, hop, autoflow"));
    assert_eq!(*panes.0.lock().unwrap(), vec!["forge-job-3".to_string()]);
    assert_eq!(registry.count(), 0);
    assert!(
        activity.refused("sess-3").is_none(),
        "a concluded job's refusal is let go"
    );
}

#[tokio::test]
async fn a_pane_with_no_refusal_is_not_concluded_by_this_reading() {
    let registry = JobPanes::new();
    let watch = Watch::Hooked {
        session_id: "sess-4".into(),
        delivered_at: now_ms(),
    };
    registry.hold("job-4", "forge-job-4", watch, None, None, Some(now_ms()));
    let report = Failures::default();
    supervise(
        &LivePanes(Mutex::new(Vec::new())),
        &report,
        &NoRecords,
        &registry,
        &Activities::new(),
    )
    .await;
    assert!(report.0.lock().unwrap().is_empty());
    assert_eq!(registry.count(), 1);
}
