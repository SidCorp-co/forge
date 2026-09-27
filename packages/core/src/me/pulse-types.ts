/**
 * The workspace pulse: what `GET /api/me/pulse` answers, in the five sections
 * the dashboard reads in order — is it alive, where is the work, what needs a
 * person, which way is the flow going, is the output any good.
 */

import type { FailureCause } from '../pipeline/failure-causes.js';

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

/** A closed issue whose work a reading of its project's branches places off the live branch. */
export interface PulseNotOnLiveIdentity extends PulseIssueIdentity {
  liveBranch: string;
  evidence: Array<{
    sha: string;
    subject: string;
    via: 'merged_commit' | 'declares_issue' | 'merged_in' | 'recorded_head';
  }>;
}

/** A `promote` project whose base and live branches could not be compared, and why. */
export interface PulseLiveGap {
  id: string;
  slug: string;
  name: string;
  baseBranch: string | null;
  liveBranch: string;
  reason: string;
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
  notOnLive: PulseCapped<PulseNotOnLiveIdentity>;
  liveUnmeasured: PulseCapped<PulseLiveGap>;
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
  sessionFailures: Array<{ reason: FailureCause; count: number }>;
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

export const PULSE_OPEN_STATUSES = ['open', 'confirmed', 'clarified', 'approved'] as const;
export const PULSE_IN_PROGRESS_STATUSES = [
  'in_progress',
  'developed',
  'testing',
  'tested',
  'reopen',
] as const;
export const PULSE_AWAITING_RELEASE_STATUSES = ['awaiting_release', 'releasing'] as const;

export const PULSE_HEARTBEAT_DAYS = 30;
export const PULSE_FLOW_WEEKS = 12;
export const PULSE_QUALITY_WINDOW_DAYS = 90;
