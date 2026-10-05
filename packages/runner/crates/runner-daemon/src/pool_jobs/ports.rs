use super::*;

/// What the box may read, take, start and give back.
#[async_trait::async_trait]
pub trait Pool: Send + Sync {
    /// A read that failed is a [`ReadFailure`] and never an empty list (ISS-1234).
    async fn claimable(&self, project_id: &str)
        -> std::result::Result<Vec<PoolEntry>, ReadFailure>;
    async fn prepare(&self, job_id: &str, session_id: &str) -> Result<Prepared>;
    async fn start(&self, job_id: &str, session_id: &str) -> Result<Started>;
    async fn release(&self, job_id: &str, session_id: &str) -> Result<()>;
    /// The MCP servers this project declares, resolved, which a job pane is started with exactly
    /// as a master pane is. A read that failed is an error and never an empty declaration: a pane
    /// started on that reading carries none of what the project declared (ISS-1235, ISS-1347).
    async fn mcp_servers(&self, project_id: &str) -> Result<ProjectMcpServers>;
}

#[async_trait::async_trait]
pub trait Report: Send + Sync {
    async fn ack(&self, job_id: &str) -> Result<()>;
    /// `Ok(false)` means core has answered that the job is no longer this box's.
    ///
    /// `runtime_state` is what the box knows the agent to be doing, or `None`
    /// where it knows nothing about it at all.
    async fn progress(&self, job_id: &str, runtime_state: Option<&str>) -> Result<bool>;
    /// `Ok(false)` means core has answered that the job is no longer this box's.
    async fn fail(&self, job_id: &str, error: &str) -> Result<bool>;
}

#[async_trait::async_trait]
pub trait Records: Send + Sync {
    async fn note(&self, live: &Live);
    async fn forget(&self, job_id: &str);
    async fn all(&self) -> Vec<Live>;
}

/// The pane a job runs in.
#[async_trait::async_trait]
pub trait Panes: Send + Sync {
    /// Start the pane as `launch` says, refusing where it cannot be.
    async fn open(
        &self,
        name: &str,
        cwd: &Path,
        prompt: &str,
        env: &[(String, String)],
        launch: &Launch<'_>,
    ) -> Result<()>;
    /// This box has let go of the job this pane ran: whatever `open` wrote for it goes.
    async fn released(&self, name: &str);
    /// Whether tmux answered that it holds no pane by this name. A question it
    /// could not answer is not an ending, so it is not `gone` (ISS-1312).
    async fn gone(&self, name: &str) -> bool;
    async fn kill(&self, name: &str) -> Result<()>;
    /// Every job pane on this box right now, by name.
    async fn names(&self) -> Vec<String>;
}

/// The production halves, over a real core and a real tmux.
pub struct CorePool<'a> {
    pub client: &'a CoreClient,
    pub limit: u32,
    /// How long a read or a preparation may take before it is a failure;
    /// [`pool::CALL_DEADLINE`] everywhere but a test.
    pub deadline: std::time::Duration,
}

#[async_trait::async_trait]
impl Pool for CorePool<'_> {
    async fn claimable(
        &self,
        project_id: &str,
    ) -> std::result::Result<Vec<PoolEntry>, ReadFailure> {
        pool::list_within(self.client, Some(project_id), self.limit, self.deadline).await
    }

    async fn prepare(&self, job_id: &str, session_id: &str) -> Result<Prepared> {
        pool::prepare_within(self.client, job_id, session_id, self.deadline).await
    }

    async fn start(&self, job_id: &str, session_id: &str) -> Result<Started> {
        pool::start(self.client, job_id, session_id).await
    }

    async fn release(&self, job_id: &str, session_id: &str) -> Result<()> {
        pool::release(self.client, Some(job_id), session_id).await
    }

    async fn mcp_servers(&self, project_id: &str) -> Result<ProjectMcpServers> {
        mcp_servers::fetch_within(self.client, project_id, self.deadline).await
    }
}

pub struct CoreReport<'a> {
    pub client: &'a CoreClient,
}

#[async_trait::async_trait]
impl Report for CoreReport<'_> {
    async fn ack(&self, job_id: &str) -> Result<()> {
        lifecycle::ack(self.client, job_id, None).await
    }

    async fn progress(&self, job_id: &str, runtime_state: Option<&str>) -> Result<bool> {
        let mut data = serde_json::json!({ "source": "pool_jobs" });
        if let Some(state) = runtime_state {
            data["runtimeState"] = serde_json::Value::String(state.to_string());
        }
        let beat = JobEventInput::new(HEARTBEAT_KIND, data);
        match events::post_job_events(self.client, job_id, &[beat]).await {
            Ok(_) => Ok(true),
            Err(e) if events::is_disowned(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn fail(&self, job_id: &str, error: &str) -> Result<bool> {
        match lifecycle::fail(self.client, job_id, error).await {
            Ok(()) => Ok(true),
            Err(e) if events::is_disowned(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// One file per started job, under the daemon's own config directory.
pub struct FileRecords {
    pub dir: PathBuf,
}

impl FileRecords {
    /// Where a daemon keeps them, beside `inflight/`.
    pub fn default_dir() -> Option<PathBuf> {
        runner_platform::config::base_dir()
            .ok()
            .map(|d| d.join("pool-jobs"))
    }

    pub(crate) fn path(&self, job_id: &str) -> Option<PathBuf> {
        if job_id.is_empty()
            || job_id.len() > 64
            || !job_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return None;
        }
        Some(self.dir.join(format!("{job_id}.json")))
    }
}

#[async_trait::async_trait]
impl Records for FileRecords {
    async fn note(&self, live: &Live) {
        let Some(path) = self.path(&live.job_id) else {
            tracing::error!(
                "[pool] refusing to record job {}: not a job id core would send",
                live.job_id
            );
            return;
        };
        let _ = std::fs::create_dir_all(&self.dir);
        let mut body = serde_json::json!({ "pane": live.pane });
        let obj = body.as_object_mut().expect("json! object");
        if let Some(session) = live.watch.session_id() {
            obj.insert("session".into(), session.into());
        }
        if let Some(seen) = live.seen {
            obj.insert("seen".into(), seen.to_json());
        }
        if let Some(path) = &live.transcript {
            obj.insert("transcript".into(), path.as_str().into());
        }
        if let Some(at) = live.opened_at {
            obj.insert("openedAt".into(), at.into());
        }
        // Never in place. A sweep replaces this file every minute now that it
        // carries the snapshot a restart is judged on, and `std::fs::write`
        // truncates before it writes: a daemon that dies mid-write would leave
        // half a record, which reads back as a pane nothing is known about and
        // so is kept for the rest of its life — the very hole the snapshot
        // closes. `session_tokens` learned this on the same disk (ISS-1099).
        if let Err(e) = replace(&self.dir, &path, &body.to_string()) {
            tracing::warn!(
                "[pool] could not record job {} at {}: {e} — the record standing there is the one a restart will read",
                live.job_id,
                path.display()
            );
        }
    }

    async fn forget(&self, job_id: &str) {
        if let Some(path) = self.path(job_id) {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn all(&self) -> Vec<Live> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(job_id) = name.strip_suffix(".json") else {
                continue;
            };
            let Ok(body) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let held = serde_json::from_str::<serde_json::Value>(&body).ok();
            let field = |k: &str| {
                held.as_ref()
                    .and_then(|v| v[k].as_str().map(str::to_string))
            };
            out.push(Live {
                job_id: job_id.to_string(),
                pane: field("pane").unwrap_or_else(|| pane_name(job_id)),
                watch: match field("session") {
                    Some(session_id) => Watch::Adopted { session_id },
                    None => Watch::Unhooked,
                },
                seen: held
                    .as_ref()
                    .map(|v| &v["seen"])
                    .and_then(job_exit::Reported::from_json),
                // Absolute or not at all, the rule `agent_activity` holds a
                // hook to: a relative path would be read against this
                // daemon's cwd and age some other file.
                transcript: field("transcript").filter(|p| Path::new(p).is_absolute()),
                opened_at: held.as_ref().and_then(|v| v["openedAt"].as_i64()),
            });
        }
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }
}

/// Put `body` at `path` whole or not at all, leaving whatever stood there if
/// the replacement cannot be completed.
pub(crate) fn replace(dir: &Path, path: &Path, body: &str) -> std::io::Result<()> {
    let tmp = dir.join(format!(
        ".pool-job.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let done = std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, path));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

pub struct NoRecords;

#[async_trait::async_trait]
impl Records for NoRecords {
    async fn note(&self, _live: &Live) {}
    async fn forget(&self, _job_id: &str) {}
    async fn all(&self) -> Vec<Live> {
        Vec::new()
    }
}

pub struct TmuxPanes;

/// Tools whose only effect is to stop the turn until a person answers, denied in every job pane.
/// Nothing on a box answers a job pane, so each of these held a slot until a sweep ended it; a
/// master pane keeps them, because its owner is the one answering.
pub const JOB_PANE_DENIED: [&str; 3] = ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"];

/// [`JOB_PANE_DENIED`] and the tools a job's policy state denies, each named once.
pub fn job_denied_tools(policy: &[String]) -> Vec<String> {
    let mut all: Vec<String> = JOB_PANE_DENIED.iter().map(|t| (*t).to_string()).collect();
    for tool in policy {
        if !all.contains(tool) {
            all.push(tool.clone());
        }
    }
    all
}

/// The command a job pane is started with: the launch a master pane takes, handed the project's
/// declared servers through a config of the job's own, the model and denied tools of its policy
/// state, every tool that waits on a person, which no job pane may call, and the job's brief as
/// the agent's first turn. A declaration or brief that cannot be written is a refusal, because the
/// pane it would start carries none of it.
pub(crate) fn job_pane_argv(
    dir: &Path,
    name: &str,
    launch: &Launch<'_>,
    prompt: &str,
) -> Result<Vec<String>> {
    let brief = runner_workspace::mcp::config::write_job_brief_in(dir, name, prompt)
        .map_err(|e| Error::Other(format!("the brief for {name} could not be written: {e}")))?;
    let servers = launch.servers;
    let config =
        runner_workspace::mcp::config::write_job_session_in(dir, name, servers).map_err(|e| {
            Error::Other(format!(
                "the project's declared MCP servers ({}) could not be written for {name}: {e}",
                servers.keys().cloned().collect::<Vec<_>>().join(", ")
            ))
        })?;
    Ok(terminal::job_argv(
        config.as_deref(),
        None,
        Some(launch.model),
        &job_denied_tools(launch.denied_tools),
        Some(&brief),
    ))
}

#[async_trait::async_trait]
impl Panes for TmuxPanes {
    async fn open(
        &self,
        name: &str,
        cwd: &Path,
        prompt: &str,
        env: &[(String, String)],
        launch: &Launch<'_>,
    ) -> Result<()> {
        if !terminal::available() {
            return Err(Error::Other(
                "tmux is not installed on this box, and a job pane needs it".into(),
            ));
        }
        let argv = job_pane_argv(
            &runner_workspace::mcp::config::session_dir(),
            name,
            launch,
            prompt,
        )?;
        // The brief rides the launch, so a pane already holding this name was started with some
        // other brief, and this job's reaches nobody.
        if !terminal::ensure(name, cwd, &argv, env, None).await? {
            return Err(Error::Other(format!(
                "a pane named {name} was already running, so this job's brief was not delivered to it"
            )));
        }
        Ok(())
    }

    async fn released(&self, name: &str) {
        if let Err(e) = runner_workspace::mcp::config::clear_job_session(name) {
            tracing::warn!(
                "[pool] {name} is over, but its MCP config could not be removed ({e}) — it holds the project's server credentials until the 24-hour sweep takes it"
            );
        }
    }

    async fn gone(&self, name: &str) -> bool {
        crate::recovery_ports::pane_presence(name).await == crate::recovery::MasterPresence::Gone
    }

    async fn kill(&self, name: &str) -> Result<()> {
        terminal::kill(name).await
    }

    async fn names(&self) -> Vec<String> {
        terminal::names_with_prefix(terminal::JOB_PREFIX).await
    }
}
