
/** A set the response counts in full and names only the first `shown.length` of. */
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
