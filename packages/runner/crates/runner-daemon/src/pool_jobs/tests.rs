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
}

struct NoReport;

#[async_trait::async_trait]
impl Report for NoReport {
    async fn ack(&self, _job_id: &str) -> Result<()> {
        unreachable!()
    }
    async fn progress(&self, _job_id: &str, _runtime_state: Option<&str>) -> Result<bool> {
        unreachable!()
    }
    async fn fail(&self, _job_id: &str, _error: &str) -> Result<bool> {
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
