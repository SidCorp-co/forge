// The workspace pulse: what `GET /api/me/pulse` answers, in the five sections the dashboard reads in
// order — is it alive, where is the work, what needs a person, which way is the flow going, is the
// output any good. Core composes it (`me/pulse-*.ts`), the overview dashboard renders it.

import type { FailureCause } from "./failure-causes.js";
import type { PulseActionRow } from "./needs-you.js";

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

/** A closed issue whose work a reading of its project"s branches places off the live branch. */
export interface PulseNotOnLiveIdentity extends PulseIssueIdentity {
	deploysFrom: string;
	evidence: Array<{
		sha: string;
		subject: string;
		via: "merged_commit" | "declares_issue" | "merged_in" | "recorded_head";
	}>;
}

/** A `promote` project whose base and live branches could not be compared, and why. */
export interface PulseLiveGap {
	id: string;
	slug: string;
	name: string;
	baseBranch: string | null;
	deploysFrom: string;
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
	runFailure: { pipeline: PulseLane; other: PulseLane };
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
	/** What needs a person or the machine, ranked (`pulse-actions.ts:pulseActionsOf`). */
	actions: PulseActionRow[];
}
