/**
 * Pipeline constants: UIDs, config sets, telemetry counters.
 */

export const SESSION_UID = 'api::agent-session.agent-session' as any;
export const ISSUE_UID = 'api::issue.issue' as any;
export const DEVICE_UID = 'api::device.device' as any;

// ─── In-memory Pipeline Telemetry (resets on server restart) ──────────────────

export const pipelineTelemetry = {
  recovered: 0,
  failed: 0,
  recoveredBy: {} as Record<string, number>,
  autoRetries: 0,
  retriesExhausted: 0,
  staleWatcher: {
    runs: 0,
    sessionsRecovered: 0,
    sessionsFailed: 0,
    lastRun: null as string | null,
  },
};

/** Max number of reopen→fix cycles before stopping the pipeline. */
export const MAX_REOPEN_CYCLES = 10;

/** Statuses considered "done-enough" — a blocker at any of these no longer blocks dependents. */
export const DONE_ENOUGH_STATUSES = new Set([
  'developed', 'deploying', 'testing', 'staging', 'released', 'closed',
]);

/**
 * Decomposition-specific: a child is "done" from its parent's perspective only
 * after it has merged to baseBranch (staging). The parent's integration test
 * runs against the staging environment, so children must all be on staging
 * before the parent can advance. Narrower than DONE_ENOUGH_STATUSES on purpose —
 * do NOT include `developed`/`deploying`/`testing`, which indicate the child is
 * still mid-flight in its own review/test loop.
 */
export const DECOMP_CHILD_READY_STATUSES = new Set([
  'staging', 'released', 'closed',
]);

/**
 * Expected outcome statuses per pipeline skill. If the issue has already moved
 * to one of these, the agent's work succeeded even if the polling loop failed.
 *
 * Does NOT include `in_progress` — that's a working status the agent sets early.
 * If the session is done and the issue is still at `in_progress`, the agent
 * died mid-task before setting the final status → treat as failure + retry.
 */
export const SKILL_EXPECTED_STATUSES: Record<string, Set<string>> = {
  'forge-triage':   new Set(['confirmed', 'needs_info']),
  'forge-clarify':  new Set(['clarified', 'needs_info']),
  'forge-plan':     new Set(['approved', 'waiting']),
  'forge-code':     new Set(['developed', 'deploying']),
  'forge-review':   new Set(['deploying', 'reopen', 'waiting']),
  'forge-test':     new Set(['staging', 'reopen']),
  'forge-fix':      new Set(['developed', 'deploying']),
  'forge-release':  new Set(['closed']),
};

/** Max retries for resuming a failed session before starting fresh. */
export const MAX_SESSION_RETRIES = 3;

/** Max fresh session attempts after resume retries are exhausted. */
export const MAX_FRESH_RETRIES = 3;

/**
 * Max context tokens before a session is considered too large to resume.
 * Above this, starting fresh avoids quality degradation and "prompt too long" errors.
 * Set to ~60% of the 1M context window — leaves headroom for the next pipeline step
 * while staying well below the ~835K auto-compact trigger.
 */
export const MAX_RESUMABLE_CONTEXT = 600_000;

/** Cooldown before retrying after a transient 529 overload (ms). */
export const OVERLOAD_COOLDOWN_MS = 2 * 60 * 1000;
