// cm:why one declaration of a run as a person reads it (design agent-run-standing rev 1; REQ-15, ISS-108):
// core derives each run's state, holder, wait, outcome, attempt and master from the rows it holds, and
// `GET /api/projects/:id/runs/standing` serves them, so no screen guesses a run's state from raw rows.
// cm:guard every derived arm that cannot be read is a `RunNone` naming why, never an empty value; a gate
// with no deadline serves `resumesAt: null`, and a hold's `expiresAt` is null only beside `expiryDetail`
// cm:why stuck is computed in core and nowhere else (ISS-109, decision 7 on the design): a live run nothing
// moves reads `stuck` with its rule, since and evidence row, so every screen reads one rule

import type { FailureCause } from "./failure-causes.js";
import type { IssueLeaseVerdict } from "./issue-standing.js";
import type { IssueStatus } from "./issue-machine.js";
import type { WorkStep } from "./issue-vocabulary.js";
import type { MasterStanding } from "./master-standing.js";
import type {
	Standing,
	StandingGroup,
	StandingGroupLabel,
	StandingGroupLabels,
	WaitingKind,
	WaitingOn,
} from "./standing.js";

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
// cm:guard one source for the silence clocks (decision 7 on agent-run-standing rev 1): stuck shows at 3 min,
// the master and run-session reapers fail at 10 min, and the loop monitor's job heartbeat reap defaults to
// 3 min; `silent` counts only a run with no live job, so it never races the job reap, and core's
// `runs/standing-stuck.test.ts` holds stuck strictly before the session reap
export const RUN_STUCK_AFTER_MS = 3 * 60_000;
export const SESSION_SILENCE_REAP_MS = 10 * 60_000;
export const JOB_HEARTBEAT_REAP_DEFAULT_MS = 3 * 60_000;
/** Result-hop quiet threshold: 60 min, because legit forge-release/forge-code merges run over 5
 *  between emissions. The demoted stale-detector alarm derives its margin from it. */
export const RESULT_QUIET_MINUTES = 60;

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

const RUN_HOLDER_KINDS = ["run", "master"] as const;
type RunHolderKind = (typeof RUN_HOLDER_KINDS)[number];

export const RUN_EXPIRY_SOURCES = [
	"claim",
	"silence_reap",
	"deploy_lock",
] as const;
export type RunExpirySource = (typeof RUN_EXPIRY_SOURCES)[number];

/** Whom a run waits on: the viewer or another person to answer or approve, its holder at work
 *  (`dueAt` the lease's end), a gate that resumes by itself (`RunGateWait`), the master, a free
 *  machine slot, or nobody. */
export const RUN_WAITING_KINDS = [
	"you",
	"person",
	"run",
	"gate",
	"master",
	"machine",
	"none",
] as const satisfies readonly WaitingKind[];
export type RunWaitingKind = (typeof RUN_WAITING_KINDS)[number];

/** The gate words a run waits behind that are not open-ended: a self-resuming job hold, a retry
 *  cooldown, a deploy lock another run holds, and the dispatch barriers pipeline health names. A
 *  box-reported blocker reads `blocked_on_<kind>`, and an automatic pause its pause kind. */
export const RUN_GATES = [
	"all_devices_exhausted",
	"verify_unavailable",
	"retry_cooldown",
	"deploy_locked",
	"issue_busy",
	"contract_wait_unsettled",
	"runner_stale",
	"runner_too_old",
] as const;
export type RunGate = (typeof RUN_GATES)[number];

/** A gate that clears without a person: which gate, when it resumes by its own deadline (null when
 *  it has none, never a guess), and the rule that put the run behind it. */
export interface RunGateWait {
	kind: "gate";
	/** A `RunGate`, `blocked_on_<kind>`, or a pause kind. */
	gate: string;
	resumesAt: string | null;
	rule: string;
}

export type RunWaitingOn =
	| WaitingOn<Exclude<RunWaitingKind, "gate">>
	| RunGateWait;

export const RUN_HANDBACK_CLOSES = ["ended", "killed_idle", "died"] as const;
export type RunHandbackClose = (typeof RUN_HANDBACK_CLOSES)[number];

export const RUN_ACTOR_TYPES = ["user", "system", "runner", "sweeper"] as const;
export type RunActorType = (typeof RUN_ACTOR_TYPES)[number];

export const RUN_STANDING_SCOPES = ["live", "finished", "all"] as const;
export type RunStandingScope = (typeof RUN_STANDING_SCOPES)[number];

/** The list groups by attention, Needs you first; `waiting` holds a person wait owed by someone else. */
export const RUN_GROUPS = [
	"needs_you",
	"waiting",
	"stuck",
	"running",
	"waiting_gate",
	"queued",
	"finished",
] as const satisfies readonly StandingGroup[];
export type RunGroup = (typeof RUN_GROUPS)[number];

export const RUN_GROUP_LABELS: StandingGroupLabels<RunGroup> = {
	needs_you: {
		label: "Needs you",
		hint: "Answer or approve; the run holds no slot meanwhile",
		tone: "you",
		collapsed: false,
	},
	waiting: {
		label: "Waiting on someone else",
		hint: "A named person owes the next act",
		tone: "neutral",
		collapsed: false,
	},
	stuck: {
		label: "Stuck",
		hint: "Silent, lease expired, or the box and core disagree",
		tone: "err",
		collapsed: false,
	},
	running: {
		label: "Running",
		hint: "Holds the lease and beats",
		tone: "run",
		collapsed: false,
	},
	waiting_gate: {
		label: "Waiting on a gate",
		hint: "Resumes by itself",
		tone: "blocked",
		collapsed: false,
	},
	queued: {
		label: "Queued",
		hint: "Admitted; waits for the master or a slot",
		tone: "ready",
		collapsed: false,
	},
	finished: {
		label: "Finished",
		hint: "Done, failed, cancelled or handed back",
		tone: "done",
		collapsed: true,
	},
};

/** The row the list draws above every run group, read from `master` beside the items. */
export const RUN_MASTER_GROUP: StandingGroupLabel = {
	label: "Project master",
	hint: "What the master is doing now",
	tone: "neutral",
	collapsed: false,
};

export const RUN_EVENT_ENTITIES = ["run", "session", "job"] as const;
export type RunEventEntity = (typeof RUN_EVENT_ENTITIES)[number];

export const RUN_EVENTS_MAX = 200;

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
	status: IssueStatus;
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
	status: IssueStatus;
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

/** The job behind a run, where one exists: its type and its own status. */
export interface RunJob {
	id: string;
	type: string;
	status: string;
}

export interface RunStanding
	extends Omit<Standing<RunGroup, RunWaitingKind>, "waitingOn"> {
	waitingOn: RunWaitingOn;
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
	outcome: RunOutcome | null;
	master: RunMasterRef;
	stuck: RunStuck;
	release: RunRelease | null;
	deployLocks: RunDeployLock[];
	pipelineStatus: string;
	job: RunJob | null;
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
		/** Live runs whose holder is held: an issue lease, a claim or a deploy lock. */
		held: number;
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

/** One kernel_transitions row of the run, its root session or its job, oldest first. */
export interface RunEvent {
	id: string;
	at: string;
	entity: RunEventEntity;
	from: string | null;
	to: string;
	reason: string | null;
	actor: {
		type: RunActorType;
		agency: "human" | "agent";
		name: string | null;
	};
	source: string;
}

export interface RunStandingDetail {
	generatedAt: string;
	run: RunStanding;
	attempts: RunAttemptRow[];
	events: RunEvent[];
	eventsHasMore: boolean;
}

/** Machine pause kinds a MACHINE clears: something in this build watches for the condition and resumes the run without anyone being asked. */
export const MACHINE_RESUMED_PAUSE_KINDS: readonly string[] = [];

/** Machine pause kinds only a PERSON clears. */
export const HUMAN_RESUMED_PAUSE_KINDS = ["stage_stalled"] as const;

/** Every machine pause-reason kind that still has code able to clear it. `pauseReason` is written as `<kind>:<detail>`; the orphaned-pause sweep frees any run whose kind is absent here. */
export const LIVE_PAUSE_REASON_KINDS = [...MACHINE_RESUMED_PAUSE_KINDS, ...HUMAN_RESUMED_PAUSE_KINDS] as const;

export type PauseReasonKind = (typeof LIVE_PAUSE_REASON_KINDS)[number];
/** True when `reason` names a kind that still exists in this build. */
export function isLivePauseReason(reason: string | null | undefined): boolean {
	if (!reason) return false;
	const kind = reason.split(":", 1)[0] ?? "";
	return (LIVE_PAUSE_REASON_KINDS as readonly string[]).includes(kind);
}

export function pauseResumesItself(reason: string | null | undefined): boolean {
	if (!reason) return false;
	const kind = reason.split(":", 1)[0] ?? "";
	return (MACHINE_RESUMED_PAUSE_KINDS as readonly string[]).includes(kind);
}

/** Who ends this pause. The one question a surface describing a pause has to answer, and the only thing its copy may branch on. */
export type PauseResumer = "operator" | "machine" | "sweeper";

/** A `pauseReason` read apart, for a surface that has to name the pause. */
export interface PauseDescription {
	/** The kind half of `<kind>:<detail>`; null for an operator pause. */
	kind: string | null;
	/** The detail half — the stage, for `stage_stalled:<stage>`. */
	detail: string | null;
	resumer: PauseResumer;
}

/** Read a `pauseReason` as the three things a banner needs: which kind holds the run, what its detail names, and who ends it. */
export function describePause(reason: string | null | undefined): PauseDescription {
	if (!reason) return { kind: null, detail: null, resumer: "operator" };
	const separator = reason.indexOf(":");
	const kind = separator === -1 ? reason : reason.slice(0, separator);
	const detail = separator === -1 ? null : reason.slice(separator + 1) || null;
	if (pauseResumesItself(reason)) return { kind, detail, resumer: "machine" };
	return { kind, detail, resumer: isLivePauseReason(reason) ? "operator" : "sweeper" };
}
