use super::*;

pub(crate) fn takes_session_permit(spec: &JobSpec) -> bool {
    spec.counts_against_session_cap
}

pub const SESSION_PERMIT_WAIT: Duration = SESSION_IDLE_TIMEOUT;

pub(crate) async fn acquire_session_permit(
    sem: Arc<tokio::sync::Semaphore>,
    cap: usize,
    wait: Duration,
    job_id: &str,
    holders: Vec<String>,
) -> Result<tokio::sync::OwnedSemaphorePermit> {
    if let Ok(permit) = sem.clone().try_acquire_owned() {
        return Ok(permit);
    }
    tracing::warn!(
        "[job {job_id}] waiting for a session slot — all {cap} permits held by {} (parked awaiting_input sessions keep theirs until residency ends)",
        describe_holders(&holders)
    );
    match tokio::time::timeout(wait, sem.acquire_owned()).await {
        Ok(Ok(permit)) => Ok(permit),
        Ok(Err(e)) => Err(Error::Other(format!("session semaphore closed: {e}"))),
        Err(_) => Err(Error::Other(format!(
            "session_permit_saturated: all {cap} permits on this box held after {}s; holders at wait start: {}",
            wait.as_secs(),
            describe_holders(&holders)
        ))),
    }
}

pub(crate) fn describe_holders(holders: &[String]) -> String {
    if holders.is_empty() {
        return "no session this runner still tracks".to_string();
    }
    holders.join(", ")
}

/// A permit taken but not yet visible as a `Session`, kept countable meanwhile.
///
/// Registers on construction and deregisters on `Drop`, so every early return
/// between the permit and the session row — a failed MCP config write, a spawn
/// that never happens — clears the entry without a cleanup path of its own.
pub(crate) struct PendingPermit {
    pub(crate) map: Arc<std::sync::Mutex<HashMap<String, String>>>,
    pub(crate) job_id: String,
}

impl PendingPermit {
    pub(crate) fn register(
        map: &Arc<std::sync::Mutex<HashMap<String, String>>>,
        job_id: &str,
        slug: Option<&str>,
    ) -> Self {
        if let Ok(mut m) = map.lock() {
            m.insert(job_id.to_string(), slug.unwrap_or("?").to_string());
        }
        Self {
            map: map.clone(),
            job_id: job_id.to_string(),
        }
    }
}

impl Drop for PendingPermit {
    fn drop(&mut self) {
        if let Ok(mut m) = self.map.lock() {
            m.remove(&self.job_id);
        }
    }
}
