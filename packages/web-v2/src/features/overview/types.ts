// web-v2 feature module: workspace overview — the client mirror of what
// `GET /api/me/pulse` answers.
//
// cm:edge contract -> packages/core/src/me/pulse-types.ts — mirrored field for field; web-v2 cannot import core, so the shape lives twice and the two move together or the dashboard draws a figure the endpoint stopped sending.

/** A set the response counts in full and names only the first `shown.length` of. */
// cm:guard render `total` as the figure and `shown` as the sample: `shown` is capped server-side, so a panel showing `shown.length` as the count presents a truncation as the whole (ISS-988 criterion 46).
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
// cm:guard read a mark off this object and never off a constant here — a threshold typed on both sides is two thresholds the moment one moves (ISS-988 criterion 23).
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

/** The statuses each work bucket is drawn from — a bucket cell's destination. */
// cm:edge contract -> packages/core/src/me/pulse-types.ts#PULSE_OPEN_STATUSES — the same four tuples, so a cell links to exactly the rows its figure counted. A status added there and not here makes the cell's list smaller than the number above it (ISS-988 criterion 47).
export const PULSE_BUCKET_STATUSES: Record<keyof PulseWorkBuckets, readonly string[]> = {
  open: ["open", "confirmed", "clarified", "approved"],
  inProgress: ["in_progress", "developed", "testing", "tested", "reopen"],
  awaitingRelease: ["awaiting_release", "releasing"],
  humanBlocked: ["waiting", "needs_info", "on_hold"],
};

export const PULSE_BUCKET_LABELS: Record<keyof PulseWorkBuckets, string> = {
  open: "Open, not picked up",
  inProgress: "In flight",
  awaitingRelease: "Awaiting release",
  humanBlocked: "Blocked on a person",
};
