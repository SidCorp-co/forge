// cm:why one declaration of a run as a person reads it (design agent-run-standing rev 1; REQ-15, ISS-108):
// core derives each run's state, holder, wait, outcome, attempt and master from the rows it holds, and
// `GET /api/projects/:id/runs/standing` serves them, so no screen guesses a run's state from raw rows.
// cm:guard every derived arm that cannot be read is a `RunNone` naming why, never an empty value; a gate
// with no deadline serves `resumesAt: null`, and a hold's `expiresAt` is null only beside `expiryDetail`
// cm:why stuck is computed in core and nowhere else (ISS-109, decision 7 on the design): a live run nothing
// moves reads `stuck` with its rule, since and evidence row, so every screen reads one rule

import type { FailureCause } from "./failure-causes.js";
import type { IssueLeaseVerdict } from "./issue-standing.js";
import type { KernelIssueStatus, WorkStep } from "./issue-vocabulary.js";
import type { MasterStanding } from "./master-standing.js";
import { pickFields } from "./projection.js";

export const RUN_STATES = [
	"queued",
	"claimed",
	"running",
	"waiting_person",
	"waiting_gate",
	"stuck",
	"done",
	"failed",
	"cancelled",
	"handed_back",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const RUN_LIVE_STATES = [
	"queued",
	"claimed",
	"running",
	"waiting_person",
	"waiting_gate",
	"stuck",
] as const satisfies readonly RunState[];
export type RunLiveState = (typeof RUN_LIVE_STATES)[number];

export const RUN_FINAL_STATES = [
	"done",
	"failed",
	"cancelled",
	"handed_back",
] as const satisfies readonly RunState[];
export type RunFinalState = (typeof RUN_FINAL_STATES)[number];

// cm:guard one source for the silence clocks (decision 7 on agent-run-standing rev 1): stuck shows at 3 min,
// the master and run-session reapers fail at 10 min, and the loop monitor's job heartbeat reap defaults to
// 3 min; `silent` counts only a run with no live job, so it never races the job reap, and core's
// `runs/standing-stuck.test.ts` holds stuck strictly before the session reap
export const RUN_STUCK_AFTER_MS = 3 * 60_000;
export const SESSION_SILENCE_REAP_MS = 10 * 60_000;
export const JOB_HEARTBEAT_REAP_DEFAULT_MS = 3 * 60_000;

export const RUN_STUCK_RULES = [
	"silent",
	"lease_expired",
	"lease_abandoned",
	"disagreement",
	"stranded",
	"overdue",
] as const;
export type RunStuckRule = (typeof RUN_STUCK_RULES)[number];

export const RUN_DISAGREEMENTS = [
	"box-live-core-terminal",
	"box-exited-core-running",
	"run-live-root-ended",
] as const;
export type RunDisagreement = (typeof RUN_DISAGREEMENTS)[number];

export const RUN_LANES = ["issue", "release", "deploy", "job"] as const;
export type RunLane = (typeof RUN_LANES)[number];

export const RUN_HOLDER_KINDS = ["run", "master", "person"] as const;
export type RunHolderKind = (typeof RUN_HOLDER_KINDS)[number];

export const RUN_EXPIRY_SOURCES = [
	"claim",
	"silence_reap",
	"deploy_lock",
] as const;
export type RunExpirySource = (typeof RUN_EXPIRY_SOURCES)[number];

export const RUN_WAIT_KINDS = [
	"person",
	"gate",
	"master",
	"machine",
	"none",
] as const;
export type RunWaitKind = (typeof RUN_WAIT_KINDS)[number];

export const RUN_HANDBACK_CLOSES = ["ended", "killed_idle", "died"] as const;
export type RunHandbackClose = (typeof RUN_HANDBACK_CLOSES)[number];

export const RUN_ACTOR_TYPES = ["user", "system", "runner", "sweeper"] as const;
export type RunActorType = (typeof RUN_ACTOR_TYPES)[number];

export const RUN_STANDING_SCOPES = ["live", "finished", "all"] as const;
export type RunStandingScope = (typeof RUN_STANDING_SCOPES)[number];

export const RUN_STANDING_LIST_DEFAULT = 50;
export const RUN_STANDING_LIST_MAX = 200;

export interface RunNone {
	source: "none";
	detail: string;
}

export interface RunDevice {
	id: string;
	name: string;
}

export interface RunIssueRef {
	key: string;
	title: string;
	status: KernelIssueStatus;
}

export interface RunExpiry {
	source: RunExpirySource;
	at: string;
	verdict: IssueLeaseVerdict;
	rule: string;
}

export type RunDispatchedBy =
	| {
			source: "pass";
			masterSessionId: string;
			passId: string;
			verb: string;
			startedAt: string;
	  }
	| {
			source: "master";
			masterSessionId: string;
			passId: null;
			detail: string;
	  }
	| RunNone;

export interface RunHeld {
	source: "held";
	kind: RunHolderKind;
	name: string;
	sessionId: string | null;
	device: RunDevice | null;
	acquiredAt: string | null;
	expiresAt: string | null;
	expirySource: RunExpirySource | null;
	verdict: IssueLeaseVerdict | null;
	expiryDetail: string | null;
	expiries: RunExpiry[];
	dispatchedBy: RunDispatchedBy;
}

export type RunHolder = RunHeld | RunNone;

export interface RunPersonWait {
	kind: "person";
	who: string;
	isViewer: boolean;
	act: string;
	ref: string;
	since: string | null;
	rule: string;
}

export interface RunGateWait {
	kind: "gate";
	gate: string;
	resumesAt: string | null;
	since: string | null;
	rule: string;
}

export interface RunMasterWait {
	kind: "master";
	who: string;
	since: string | null;
	rule: string;
}

export interface RunMachineWait {
	kind: "machine";
	slots: { inUse: number; max: number };
	since: string | null;
	rule: string;
}

export interface RunNoWait {
	kind: "none";
	rule: string;
}

export type RunWaitingOn =
	| RunPersonWait
	| RunGateWait
	| RunMasterWait
	| RunMachineWait
	| RunNoWait;

export interface RunActor {
	type: RunActorType;
	agency: "human" | "agent";
	userId: string | null;
	name: string | null;
	reason: string | null;
	at: string;
}

export interface RunReturned {
	issueKey: string;
	status: KernelIssueStatus;
}

export type RunOutcome =
	| { kind: "done"; at: string | null; by: RunActor | RunNone }
	| {
			kind: "failed";
			at: string | null;
			cause: FailureCause;
			classified: boolean;
			detail: string | null;
	  }
	| {
			kind: "cancelled";
			at: string | null;
			by: RunActor | RunNone;
	  }
	| {
			kind: "handed_back";
			at: string | null;
			close: RunHandbackClose | null;
			returnedTo: RunReturned[];
			detail: string;
	  };

export type RunStep =
	| { source: "work_state"; step: WorkStep; since: string | null }
	| { source: "run_column"; step: string; since: null }
	| { source: "phase_journal"; step: string; since: null }
	| { source: "none"; step: null; detail: string };

export type RunAttempt =
	| { source: "runs"; n: number; retryOf: string | null; of: string }
	| RunNone;

export type RunMasterRef =
	| {
			source: "session";
			sessionId: string;
			name: string | null;
			live: boolean;
	  }
	| RunNone;

export interface RunStuckEvidence {
	table: string;
	id: string;
	column: string;
	value: string | null;
	at: string | null;
}

export interface RunStuckOn {
	source: "stuck";
	rule: RunStuckRule;
	disagreement: RunDisagreement | null;
	since: string;
	evidence: RunStuckEvidence;
	failsAt: string | null;
	failsBy: string;
	detail: string;
}

export interface RunStuckClear {
	source: "clear";
	detail: string;
}

export type RunStuck = RunStuckOn | RunStuckClear | RunNone;

export interface RunRelease {
	version: string | null;
	stage: string | null;
	verdict: string | null;
	attemptAt: string | null;
}

export interface RunDeployLock {
	environment: string;
	subject: string;
	acquiredAt: string;
	expiresAt: string;
	reclaimedFromRunId: string | null;
}

export interface RunStanding {
	id: string;
	projectId: string;
	lane: RunLane;
	state: RunState;
	since: string | null;
	rule: string;
	title: string;
	issue: RunIssueRef | null;
	issues: string[];
	sessionId: string | null;
	step: RunStep;
	attempt: RunAttempt;
	lastBeatAt: string | null;
	liveJobs: number;
	device: RunDevice | null;
	holder: RunHolder;
	waitingOn: RunWaitingOn;
	needsViewer: boolean;
	outcome: RunOutcome | null;
	master: RunMasterRef;
	stuck: RunStuck;
	release: RunRelease | null;
	deployLocks: RunDeployLock[];
	pipelineStatus: string;
	startedAt: string;
	finishedAt: string | null;
}

export interface RunExcluded {
	what: string;
	count: number;
	rule: string;
}

export interface RunStandingList {
	generatedAt: string;
	projectId: string;
	scope: RunStandingScope;
	scopeRule: string;
	items: RunStanding[];
	total: number;
	limit: number;
	offset: number;
	hasMore: boolean;
	counts: {
		live: number;
		finished: number;
		liveByState: Record<RunLiveState, number>;
		needsViewer: number;
	};
	excluded: RunExcluded[];
	master: MasterStanding;
}

export interface RunAttemptRow {
	id: string;
	n: number;
	state: RunState;
	startedAt: string;
	finishedAt: string | null;
}

export interface RunStandingDetail {
	generatedAt: string;
	run: RunStanding;
	attempts: RunAttemptRow[];
}

export const RUN_SUMMARY_FIELDS = [
	"id",
	"lane",
	"state",
	"since",
	"title",
	"issue",
	"step",
	"attempt",
	"holder",
	"waitingOn",
	"needsViewer",
	"outcome",
	"lastBeatAt",
	"stuck",
	"startedAt",
] as const satisfies readonly (keyof RunStanding)[];
export type RunSummaryView = Pick<
	RunStanding,
	(typeof RUN_SUMMARY_FIELDS)[number]
>;

export const runSummaryOf = (run: RunStanding): RunSummaryView =>
	pickFields(run, RUN_SUMMARY_FIELDS);
