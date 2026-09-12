/**
 * The workspace pulse: what `GET /api/me/pulse` answers, in the five sections
 * the dashboard reads in order — is it alive, where is the work, what needs a
 * person, which way is the flow going, is the output any good.
 */

// cm:edge contract -> packages/web-v2/src/features/overview/types.ts — that file mirrors this one field for field; the two move together or the dashboard draws a figure the endpoint stopped sending.

/** A set the response counts in full and names only the first `shown.length` of. */
// cm:guard `total` is the COUNT and `shown` is capped: a panel rendering `shown.length` as the figure is the truncation-as-truth defect ISS-988 criterion 46 exists to refuse.
export interface PulseCapped<T> {
  total: number;
  shown: T[];
}

export interface PulseJobIdentity {
  jobId: string;
  runId: string;
  type: string;
  projectSlug: string;
  issueRef: string | null;
  issueDocId: string | null;
  ageSeconds: number;
}

export interface PulseRunIdentity {
  runId: string;
  projectSlug: string;
  issueRef: string | null;
  issueDocId: string | null;
  ageSeconds: number;
}

export interface PulseIssueIdentity {
  documentId: string;
  issueRef: string;
  title: string;
  status: string;
  projectSlug: string;
  ageSeconds: number;
}

export interface PulseProjectIdentity {
  id: string;
  slug: string;
  name: string;
  backlog: number;
  lastIssueRunAt: string | null;
}

/** Every cutoff the surface marks against, so the client owns none of them. */
// cm:guard the client reads these and never a constant of its own — a threshold typed on both sides is two thresholds the moment one moves, and the dashboard's job is to agree with the figures it draws.
export interface PulseThresholds {
  abandonedIssueSeconds: number;
  releaseWaitingSeconds: number;
  projectSilenceSeconds: number;
  silenceWarnSeconds: number;
  silenceAlarmSeconds: number;
  identityCap: number;
}

export interface PulseHeartbeatDay {
  date: string;
  issueRuns: number;
}

export interface PulseLiveness {
  jobsRunning: number;
  jobsQueued: number;
  jobsHeld: number;
  liveJobs: PulseCapped<PulseJobIdentity>;
  // cm:guard runs at `running`/`paused` with NO job at queued/dispatched/running/held. Counted off `jobs`, never off `pipeline_runs.status`, which said 42 of 42 were live work on 2026-09-12.
  stuckRuns: PulseCapped<PulseRunIdentity>;
  lastJobAt: string | null;
  silenceSeconds: number | null;
  heartbeat: PulseHeartbeatDay[];
  devices: { online: number; draining: number; total: number };
}

export interface PulseWorkBuckets {
  open: number;
  inProgress: number;
  awaitingRelease: number;
  humanBlocked: number;
}

export interface PulseProjectRow extends PulseWorkBuckets {
  id: string;
  slug: string;
  name: string;
  stuckRuns: number;
  abandonedIssues: number;
  lastIssueRunAt: string | null;
}

export interface PulseWork {
  buckets: PulseWorkBuckets;
  // cm:guard an `in_progress` issue with no live job AND idle past `abandonedIssueSeconds` — the issue-shaped half of `stuckRuns`. ISS-977 and ISS-983 sat here for seventeen hours counted as work in flight.
  abandoned: PulseCapped<PulseIssueIdentity>;
  releaseWaiting: PulseCapped<PulseIssueIdentity>;
  silentProjects: PulseCapped<PulseProjectIdentity>;
  neverRanProjects: PulseCapped<PulseProjectIdentity>;
  humanBlockedAges: number[];
  perProject: PulseProjectRow[];
}

export interface PulseFlowWeek {
  weekStart: string;
  created: number;
  closed: number;
  reopened: number;
  backlog: number;
}

export interface PulseLane {
  failed: number;
  total: number;
}

export interface PulseQuality {
  finished: { merged: number; closedUnmerged: number; dropped: number };
  reopened: { issues: number; events: number };
  rework: { fix: number; code: number };
  // cm:guard `pipeline` is kind='issue' and `scheduler` is kind='system'; `pm` and `interactive` are neither and go to `other` rather than being folded into scheduler, which would price chat sessions as machinery failures.
  runFailure: { pipeline: PulseLane; scheduler: PulseLane; other: PulseLane };
  sessionFailures: Array<{ reason: string; count: number }>;
  pipelineFlow: Array<{ type: string; count: number; medianSeconds: number | null }>;
}

export interface PulseResponse {
  generatedAt: string;
  thresholds: PulseThresholds;
  liveness: PulseLiveness;
  work: PulseWork;
  flow: PulseFlowWeek[];
  quality: PulseQuality;
}

export const PULSE_THRESHOLDS: PulseThresholds = {
  abandonedIssueSeconds: 3600,
  releaseWaitingSeconds: 86_400,
  projectSilenceSeconds: 604_800,
  silenceWarnSeconds: 86_400,
  silenceAlarmSeconds: 259_200,
  identityCap: 50,
};

/** Jobs that hold a runner slot: a run or an issue with one of these is live. */
// cm:edge contract -> packages/core/src/health/service.ts#ACTIVE_JOB_STATUSES — the same four, and `held` belongs for the reason stated there: it is a live job waiting on a mechanical condition. Diverge and a `held` job makes its run read as stuck.
export const PULSE_LIVE_JOB_STATUSES = ['queued', 'dispatched', 'running', 'held'] as const;

export const PULSE_OPEN_STATUSES = ['open', 'confirmed', 'clarified', 'approved'] as const;
export const PULSE_IN_PROGRESS_STATUSES = [
  'in_progress',
  'developed',
  'testing',
  'tested',
  'reopen',
] as const;
export const PULSE_AWAITING_RELEASE_STATUSES = ['awaiting_release', 'releasing'] as const;
export const PULSE_HUMAN_BLOCKED_STATUSES = ['waiting', 'needs_info', 'on_hold'] as const;
// cm:guard the four buckets partition every status EXCEPT `closed`, `dropped` and `draft`. A status added to the enum and not to one of them vanishes from the dashboard's 491 without a figure changing — `pulse-work.test.ts` asserts the partition against `issueStatuses` so the omission goes red.
export const PULSE_FINISHED_STATUSES = ['closed', 'dropped'] as const;

export const PULSE_HEARTBEAT_DAYS = 30;
export const PULSE_FLOW_WEEKS = 12;
export const PULSE_QUALITY_WINDOW_DAYS = 90;
