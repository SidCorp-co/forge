// The steward's contract (REQ-48, docs/proposals/steward-agent.md): the one standing read every
// screen and the chat report draw (BC-8, BC-9), the steward note written against it (BC-7), and the
// run and act records the steward leaves on an item (BC-1, BC-12). Lane A builds the read, the note
// store and every surface; lane B builds the runtime and the acts against these types alone.

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";
import type { Said } from "./said.js";
import type { StandingGroup, WaitingKind, WaitingOn } from "./standing.js";
import { WAITING_KINDS } from "./standing.js";

/** What a standing is read for. An issue's standing is read for its own pages and for the roll-up. */
export const STANDING_SUBJECT_KINDS = [
	"requirement",
	"feedback",
	"issue",
] as const;
export type StandingSubjectKind = (typeof STANDING_SUBJECT_KINDS)[number];

/** What a steward note is written on (BC-7): every item the standing read lists, an issue included. */
export const STEWARD_NOTE_SUBJECT_KINDS = [
	"requirement",
	"feedback",
	"issue",
] as const;
export type StewardNoteSubjectKind =
	(typeof STEWARD_NOTE_SUBJECT_KINDS)[number];

export interface StandingSubject<
	K extends StandingSubjectKind = StandingSubjectKind,
> {
	kind: K;
	id: string;
	/** REQ-n, FB-n or ISS-n. */
	key: string;
}

/**
 * Why an item is stuck (BC-5), first that holds wins, in this order:
 * - `no_owner`: a requirement nobody owns.
 * - `nobody_serves`: it waits on a party that does not exist or does not serve the project: the
 *   master where the project's master standing reads `none` or `silent`, a permission nobody holds,
 *   or a named person who is not a member.
 * - `draft_carrier`: it is carried by a draft issue, which nothing opens by itself.
 * - `blocked`: an issue a live blocker holds, or one the dispatch door refuses: something else moves
 *   first. A requirement never reads stuck by a blocked issue alone, since the blocker is read itself.
 * - `overdue`: its next act is past its due (`dueAt`, or the default `STANDING_DUE` gives).
 */
export const STUCK_CODES = [
	"no_owner",
	"nobody_serves",
	"draft_carrier",
	"blocked",
	"overdue",
] as const;
export type StuckCode = (typeof STUCK_CODES)[number];

/** Whether the project's master acts on what waits on it: `none` and `silent` read `nobody_serves`. */
export const MASTER_SERVINGS = ["serves", "none", "silent"] as const;
export type MasterServing = (typeof MASTER_SERVINGS)[number];

/** The class of act a wait names, which picks its default due where the wait carries none. */
export const STANDING_ACT_CLASSES = [
	"master_take",
	"master_plan",
	"person_decide",
	"ba_check",
	"release_cut",
	"judge",
	"run",
	"reporter",
	"other",
] as const;
export type StandingActClass = (typeof STANDING_ACT_CLASSES)[number];

/**
 * Working days from `since` to the default due of a wait with no due of its own; null never falls
 * due by this rule (a run holding the issue is judged by its run standing; a reporter by the
 * feedback verify window). These replace requirement-to-delivery r17 `turn`'s "untouched 21 days".
 */
export const STANDING_DUE_WORKING_DAYS: Readonly<
	Record<StandingActClass, number | null>
> = {
	/** Take an open or reopened issue, start a dispatch. */
	master_take: 1,
	/** Break down (BREAKDOWN_SLA_WORKING_DAYS), re-plan, prove an unproven BC. */
	master_plan: 2,
	/** Answer, agree, approve, accept, re-pin, promote a draft, triage. */
	person_decide: 2,
	/** The BA's acceptance check (CHECK_SLA_WORKING_DAYS). */
	ba_check: 5,
	/** Cut or approve the release once every carried issue has landed. */
	release_cut: 2,
	/** Judge a landed change. */
	judge: 1,
	run: null,
	reporter: null,
	other: 10,
};

/** A stuck reading: the rule that holds, since when, and the reason in BA words. */
export interface StuckReading {
	code: StuckCode;
	/** When the rule began to hold: the due passed, the draft carrier was routed, the master went silent. */
	since: string;
	/** One BA sentence: "ISS-498 was sent back on 2026-10-14 and no master serves this project". */
	reason: string;
	/** The issue the reading was rolled up from, where it was (BC-9); else null. */
	via: string | null;
	says: { reason: Said };
}

/**
 * What every slice's standing adds to its `attentionGroup` and `waitingOn` (BC-8): since when, by when,
 * whether it is stuck and why, and what it was rolled up from. `RequirementStanding`, the feedback
 * view's standing and `IssueStanding` each extend it, so a list, a page, the Dashboard and the chat
 * report read one set of fields and none computes its own.
 */
export interface StandingTimes {
	actClass: StandingActClass;
	/** When this wait began: the move or the write that made it true, read from the records. */
	since: string;
	/** The wait's own due, else the default `STANDING_DUE_WORKING_DAYS` gives from `since`; null where none applies. */
	dueAt: string | null;
	/** Set exactly when the slice groups it `stuck`, or on a `needs_you` row whose due has passed (the person is told, so it keeps its group). */
	stuck: StuckReading | null;
	/** The issue whose own standing this wait was rolled up from (BC-9); else null. */
	carriedBy: string | null;
	/**
	 * What a note must agree with (`standingBasisOf`), always taken from the read with no viewer (no
	 * `needs_you`, no `you`), so every viewer's page compares one basis; a note on another is stale.
	 */
	basis: string;
}

/**
 * The one standing read (BC-8): one row per open item, `GET /api/projects/:id/standings` and the
 * `forge_standing` tool, served from the same per-slice derivations the lists draw.
 */
export interface ItemStanding<G extends StandingGroup = StandingGroup>
	extends StandingTimes {
	subject: StandingSubject;
	title: string;
	/** The slice's attention group. */
	group: G;
	/** Who, act, rule, ref and their `says`; `waitingOn.dueAt` is the wait's own due, null where it has none. */
	waitingOn: WaitingOn;
	/** The current steward note, where the subject takes one (BC-7). */
	note: StewardNote | null;
}

/** The read lane B's sweep and runtime call: every open item's standing in a project, no viewer. */
export type OpenStandingsRead = (projectId: string) => Promise<ItemStanding[]>;

/** The fields a basis hashes, in order: what a steward note claims about. */
export interface StandingBasisFields {
	group: StandingGroup;
	waitingKind: WaitingKind;
	/** Who the wait names, as written with no viewer ("Master", "Minh", "ISS-12"). */
	who: string;
	/** The registry key of the act owed (`says.act.key`), so a new act is a new basis. */
	actKey: string;
	ref: string | null;
	stuckCode: StuckCode | null;
	dueAt: string | null;
	carriedBy: string | null;
}

/** The basis string of a standing: its claimable fields joined, so two reads of one standing agree. */
export function standingBasisOf(s: StandingBasisFields): string {
	return [
		s.group,
		s.waitingKind,
		s.who,
		s.actKey,
		s.ref ?? "-",
		s.stuckCode ?? "-",
		s.dueAt ?? "-",
		s.carriedBy ?? "-",
	].join("|");
}

const PERSON_KINDS: readonly WaitingKind[] = [
	"you",
	"person",
	"admins",
	"writers",
];

/**
 * The fields a basis hashes, read the same for every viewer: `needs_you` reads as the group the item
 * has for nobody in particular (`stuck`, else `waiting`), and a person's wait as `person`, never as
 * "You" or a name the viewer changes.
 */
export function basisFieldsOf(
	s: Pick<StandingTimes, "stuck" | "dueAt" | "carriedBy"> & {
		group: StandingGroup;
		waitingOn: Pick<WaitingOn, "kind" | "who" | "ref" | "says">;
	},
): StandingBasisFields {
	const person = PERSON_KINDS.includes(s.waitingOn.kind);
	return {
		group: s.group === "needs_you" ? (s.stuck ? "stuck" : "waiting") : s.group,
		waitingKind: person ? "person" : s.waitingOn.kind,
		who: person ? "person" : s.waitingOn.who,
		actKey: s.waitingOn.says.act.key,
		ref: s.waitingOn.ref,
		stuckCode: s.stuck?.code ?? null,
		dueAt: s.dueAt,
		carriedBy: s.carriedBy,
	};
}

/** What a note claims about a standing, from its basis fields: the claims the vet compares field by field. */
export function claimsOf(f: StandingBasisFields): StewardClaims {
	return {
		group: f.group,
		waitingKind: f.waitingKind,
		ref: f.ref,
		stuck: f.stuckCode !== null,
		stuckCode: f.stuckCode,
		dueAt: f.dueAt,
	};
}

/** At most this many lines, each at most this long (BC-7). */
export const STEWARD_NOTE_MAX_LINES = 2;
export const STEWARD_NOTE_LINE_MAX = 160;
export const STEWARD_NOTE_CITES_MAX = 8;

/** The records a note may cite. */
export const STEWARD_CITE_KINDS = [
	"requirement",
	"feedback",
	"issue",
	"release",
	"verdict",
	"question",
	"suggestion",
	"comment",
	"run",
] as const;
export type StewardCiteKind = (typeof STEWARD_CITE_KINDS)[number];

export const stewardCiteSchema = z.strictObject({
	kind: z.enum(STEWARD_CITE_KINDS),
	/** A key (ISS-4, REQ-2, FB-9, a version) or an id (uuid) for records with no key. */
	ref: z.string().trim().min(1).max(200),
});
export type StewardCite = z.infer<typeof stewardCiteSchema>;

/**
 * What a note says about the standing, as fields the write's vet compares with the standing read at
 * write (BC-8): any one that disagrees refuses the write `STEWARD_NOTE_CONTRADICTS`, naming it.
 */
export const stewardClaimsSchema = z.strictObject({
	group: z.string().min(1).max(40),
	waitingKind: z.enum(WAITING_KINDS),
	/** The record the wait names (ISS-284, a version), or null where it names none. */
	ref: z.string().max(200).nullable(),
	stuck: z.boolean(),
	stuckCode: z.enum(STUCK_CODES).nullable(),
	/** The due the note's next act is by, or null where it names none. */
	dueAt: z.iso.datetime().nullable(),
});
export type StewardClaims = z.infer<typeof stewardClaimsSchema>;

/** `PUT /api/projects/:id/steward-notes/:subjectKind/:key` and the `forge_steward note` tool. */
export const stewardNoteWriteSchema = z.strictObject({
	/** Line 1: what happened and what blocks; line 2: what is next and by when. */
	lines: z
		.array(z.string().trim().min(1).max(STEWARD_NOTE_LINE_MAX))
		.min(1)
		.max(STEWARD_NOTE_MAX_LINES),
	cites: z.array(stewardCiteSchema).min(1).max(STEWARD_NOTE_CITES_MAX),
	claims: stewardClaimsSchema,
	/** The `basis` of the standing the writer read; another one now refuses `STEWARD_NOTE_STALE`. */
	basis: z.string().min(1).max(400),
	/** The steward run that wrote it; null for a person's override. */
	runId: z.uuid().nullable(),
});
export type StewardNoteWrite = z.infer<typeof stewardNoteWriteSchema>;

/** A note as every page and the chat report read it. */
export interface StewardNote {
	subject: StandingSubject<StewardNoteSubjectKind>;
	lines: string[];
	cites: StewardCite[];
	claims: StewardClaims;
	basis: string;
	/** The standing has moved since the note was written: the page shows it marked stale, under the standing. */
	stale: boolean;
	writtenAt: string;
	writtenBy: { id: string; name: string | null; kind: "human" | "agent" };
	runId: string | null;
}

/**
 * The handoff events that start the steward (BC-1). Each is an outbox event: `STEWARD_TRIGGER_EVENT`
 * names the one core emits, the existing ones as they are and four new ones (`StewardEventPayloads`).
 */
export const STEWARD_TRIGGERS = [
	"requirement.agreed",
	"breakdown.proposed",
	"feedback.filed",
	"standing.stuck",
	"release.asked",
	"release.held",
	"release.shipped",
	"standing.changed",
] as const;
export type StewardTrigger = (typeof STEWARD_TRIGGERS)[number];

/** The outbox event behind each trigger, and the filter on its payload where one event serves several. */
export const STEWARD_TRIGGER_EVENT: Readonly<
	Record<StewardTrigger, { event: string; when: string | null }>
> = {
	"requirement.agreed": { event: "requirement.agreed", when: null },
	"breakdown.proposed": {
		event: "suggestion.proposed",
		when: "kind is breakdown",
	},
	"feedback.filed": { event: "feedback.filed", when: null },
	"standing.stuck": { event: "standing.stuck", when: null },
	"release.asked": {
		event: "issue.transitioned",
		when: "to is awaiting_release",
	},
	"release.held": { event: "release.held", when: null },
	"release.shipped": { event: "release.shipped", when: null },
	"standing.changed": { event: "standing.changed", when: null },
};

/** The payloads of the four outbox events this work adds; lane B registers them in `outbox-events.ts`. */
export interface StewardEventPayloads {
	/** A suggestion was proposed or revised (`suggestions/propose.ts`). */
	"suggestion.proposed": {
		projectId: string;
		suggestionId: string;
		kind: string;
		targetKind: string;
		targetId: string;
	};
	/** The standing sweep saw an item turn stuck. */
	"standing.stuck": {
		projectId: string;
		subject: StandingSubject;
		code: StuckCode;
		basis: string;
	};
	/** The standing sweep saw an item's basis move off its note's. */
	"standing.changed": {
		projectId: string;
		subject: StandingSubject;
		basis: string;
	};
	/**
	 * A release held issues back for an unearned criterion: the automatic release recorded a criteria
	 * hold on them (`release-batch/hold.ts:writeReleaseHolds`), in the hold's own transaction.
	 */
	"release.held": {
		projectId: string;
		/** The release run that held them; null for the automatic release, which holds before any run is cut. */
		runId: string | null;
		held: { issueId: string; criteria: string[] }[];
	};
}

/** What the steward does, one act per run (BC-2..BC-7, BC-10). */
export const STEWARD_ACTS = [
	"note",
	"intake_check",
	"breakdown_check",
	"triage_draft",
	"stuck_diagnosis",
	"output_check",
	"release_followthrough",
] as const;
export type StewardAct = (typeof STEWARD_ACTS)[number];

/** Where an act runs: a core turn on the assistant's gateway, or an agent job on a runner. */
export const STEWARD_RUNTIMES = ["gateway_turn", "runner_job"] as const;
export type StewardRuntime = (typeof STEWARD_RUNTIMES)[number];

export const STEWARD_ACT_RUNTIME: Readonly<Record<StewardAct, StewardRuntime>> =
	{
		note: "gateway_turn",
		intake_check: "gateway_turn",
		breakdown_check: "gateway_turn",
		triage_draft: "runner_job",
		stuck_diagnosis: "gateway_turn",
		output_check: "gateway_turn",
		release_followthrough: "runner_job",
	};

/** Which act a trigger starts, and on which subject kind. `standing.changed` only rewrites the note. */
export const STEWARD_TRIGGER_ACT: Readonly<Record<StewardTrigger, StewardAct>> =
	{
		"requirement.agreed": "intake_check",
		"breakdown.proposed": "breakdown_check",
		"feedback.filed": "triage_draft",
		"standing.stuck": "stuck_diagnosis",
		"release.asked": "output_check",
		"release.held": "output_check",
		"release.shipped": "release_followthrough",
		"standing.changed": "note",
	};

export const STEWARD_RUN_STATES = [
	"queued",
	"running",
	"done",
	"failed",
	"skipped",
] as const;
export type StewardRunState = (typeof STEWARD_RUN_STATES)[number];

/**
 * Why a run failed: `refused`, a door refused one of its acts, which only a moved standing changes,
 * so the sweep never starts that act again on the same basis; `error`, the turn or its job did not
 * finish, which the sweep tries again an hour later.
 */
export const STEWARD_FAILURE_KINDS = ["refused", "error"] as const;
export type StewardFailureKind = (typeof STEWARD_FAILURE_KINDS)[number];

/**
 * What the steward asks a person to decide about a stuck issue (REQ-48 BC-5): a set fixed by code,
 * never options the model spells, so every such question reads alike and is answered in bulk. The
 * model picks only the recommended one and says why in one line. Answering carries the act out as
 * the answerer (`core/src/steward/decision-act.ts`): `open` admits the draft through the kernel (its
 * driver writes the plan and criteria in its own phases), `drop` drops it with the reason given,
 * and `keep` records the keep, so the same question is not asked again while the standing holds.
 */
export const STEWARD_DECISIONS = ["open", "keep", "drop"] as const;
export type StewardDecision = (typeof STEWARD_DECISIONS)[number];

/** Each decision's option id: the question's mark, which the answer and the Needs you read key on. */
export const STEWARD_DECISION_OPTION_IDS = {
	open: "steward.open",
	keep: "steward.keep",
	drop: "steward.drop",
} as const satisfies Record<StewardDecision, string>;

/** The decisions that take the answerer's reason: a keep says until when or why, a drop why it is not work. */
export const STEWARD_DECISIONS_WITH_REASON: readonly StewardDecision[] = [
	"keep",
	"drop",
];

/**
 * The decisions an issue owes a person, by what it is and why it reads stuck: a draft is opened,
 * kept or dropped; work nobody started that no master serves is kept waiting or dropped. Any other reading names
 * an act somebody already owes (a release approval, an open question, a blocker), which the steward
 * wakes or notes and never asks about again: null.
 */
/** Work admitted and not yet taken: what a master would take next. */
const UNSTARTED_LIVE: readonly string[] = ["open", "reopen", "on_hold"];

export function stewardDecisionsFor(
	status: string,
	stuck: StuckCode | null,
): readonly StewardDecision[] | null {
	if (status === "draft") return STEWARD_DECISIONS;
	if (stuck === "nobody_serves" && UNSTARTED_LIVE.includes(status))
		return ["keep", "drop"];
	return null;
}

/** The decision an option id names, or null for an option the steward's set does not hold. */
export function stewardDecisionOf(
	optionId: string | null | undefined,
): StewardDecision | null {
	const hit = (
		Object.entries(STEWARD_DECISION_OPTION_IDS) as [StewardDecision, string][]
	).find(([, id]) => id === optionId);
	return hit ? hit[0] : null;
}

/** Whether a round's options are a steward decision's: every one of them is from the fixed set. */
export function isStewardDecisionQuestion(
	options: readonly { id: string }[] | undefined,
): boolean {
	return (
		(options?.length ?? 0) > 0 &&
		(options ?? []).every((o) => stewardDecisionOf(o.id) !== null)
	);
}

/** Each decision's button, as a person reads it; a draft's keep and a live issue's differ. */
export function stewardDecisionLabel(
	decision: StewardDecision,
	draft: boolean,
): string {
	if (decision === "open") return "Open it: admit it for work";
	if (decision === "drop") return "Drop it: it is not work";
	return draft ? "Keep it as a draft" : "Keep it waiting";
}

/** What answering each decision does, said on its button before it is pressed. */
export const STEWARD_DECISION_EFFECTS = {
	open: "Opens the issue as you. Its driver writes the plan and criteria; the kernel's ready check still applies, and a gap is refused by name.",
	keep: "Keeps it as it is, with your reason. The steward does not ask again while its standing holds.",
	drop: "Drops the issue as you, with your reason.",
} as const satisfies Record<StewardDecision, string>;

/** Why a run was skipped rather than run: said on the item, never silent. */
export const STEWARD_SKIP_REASONS = [
	"basis_unchanged",
	"budget_spent",
	"steward_off",
	"subject_ended",
] as const;
export type StewardSkipReason = (typeof STEWARD_SKIP_REASONS)[number];

/** A trigger starts its run within this (BC-1); events inside the debounce fold into one run. */
export const STEWARD_START_WITHIN_MS = 5 * 60_000;
export const STEWARD_DEBOUNCE_MS = 2 * 60_000;
/** A stuck item gets its diagnosis and act within this (REQ-48 "measured by"). */
export const STEWARD_STUCK_ACT_WITHIN_MS = 60 * 60_000;
/** The stuck sweep's period: an item turning stuck by time is seen within it. */
export const STANDING_SWEEP_MS = 5 * 60_000;

/** Per project and UTC day, unless the project's `steward` policy lowers them. */
export const STEWARD_DAILY_BUDGET = {
	gatewayTurns: 200,
	runnerJobs: 10,
} as const;

/**
 * A steward run as the item's page and the run log read it (BC-1). A run carries every distinct act
 * its folded triggers asked for and runs them in `STEWARD_ACTS` order; a trigger arriving while it
 * runs adds its act to `followUp`, which the run's end queues as the next run, never dropping one.
 */
export interface StewardRunView {
	id: string;
	subject: StandingSubject;
	trigger: StewardTrigger;
	/** Every trigger folded into this run, oldest first. */
	events: { trigger: StewardTrigger; outboxId: string; at: string }[];
	/** Distinct, in `STEWARD_ACTS` order. */
	actsToRun: StewardAct[];
	/** Acts asked for while this run ran: the next run's `actsToRun`. */
	followUp: StewardAct[];
	/** The standing basis the run read at start: the sweep starts no stuck diagnosis for a subject
	 *  already holding a run on the same basis, notes or none (issues take no note). */
	basis: string;
	state: StewardRunState;
	skipReason: StewardSkipReason | null;
	/** Why a `failed` run failed, naming the door, the code or the missing runner; null otherwise. */
	failure: string | null;
	/** The job a runner act ran as, or the assistant turn a gateway act ran as. */
	jobId: string | null;
	turnId: string | null;
	queuedAt: string;
	startedAt: string | null;
	endedAt: string | null;
	/** What the run did, through which doors (BC-12). */
	acts: StewardActRecord[];
}

/**
 * One act through an existing door (BC-12): the door it called, what it changed, and the door that
 * undoes it, where one exists. `undo` null means a person overrides it by the record's own act.
 */
export interface StewardActRecord {
	id: string;
	runId: string;
	/** The existing route the act called, as `METHOD /api/...` with its params filled. */
	door: string;
	/** What it did, in one BA sentence. */
	did: string;
	says: { did: Said };
	/** The record it wrote (a question id, a suggestion id, a comment id, ISS-n). */
	wrote: StewardCite | null;
	undo: { door: string; body: Record<string, unknown> | null } | null;
	undoneAt: string | null;
	undoneBy: string | null;
	at: string;
}

export const STEWARD_REFUSAL_CODES = [
	"STEWARD_NOTE_SUBJECT_UNKNOWN",
	"STEWARD_NOTE_TOO_LONG",
	"STEWARD_NOTE_CITE_UNKNOWN",
	"STEWARD_NOTE_CITE_MISSING",
	"STEWARD_NOTE_STALE",
	"STEWARD_NOTE_CONTRADICTS",
	"STEWARD_NOTE_FORBIDDEN",
	"STEWARD_RUN_LIVE",
	"STEWARD_RUN_UNKNOWN",
	"STEWARD_RUN_NOT_JOB",
	"STEWARD_RUN_FORBIDDEN",
	"STEWARD_ACT_UNKNOWN",
	"STEWARD_ACT_NOT_UNDOABLE",
	"STEWARD_ACT_SUPERSEDED",
	"STEWARD_BUDGET_SPENT",
	"STEWARD_DECISION_REASON_REQUIRED",
	"STEWARD_DECISION_STALE",
] as const;
export type StewardRefusalCode = (typeof STEWARD_REFUSAL_CODES)[number];

/** Codes that answer other than 422; a `_FORBIDDEN` code answers 403 unlisted. */
export const STEWARD_REFUSAL_STATUSES = {
	STEWARD_NOTE_SUBJECT_UNKNOWN: 404,
	STEWARD_NOTE_STALE: 409,
	STEWARD_RUN_LIVE: 409,
	STEWARD_RUN_UNKNOWN: 404,
	STEWARD_RUN_NOT_JOB: 409,
	STEWARD_ACT_UNKNOWN: 404,
	STEWARD_ACT_SUPERSEDED: 409,
	STEWARD_BUDGET_SPENT: 409,
	STEWARD_DECISION_STALE: 409,
} as const satisfies RefusalStatuses<StewardRefusalCode>;

/** At most this many decisions per person in Needs you at a time (BC-11); the rest are counted, never dropped. */
export const NEEDS_YOU_PERSON_CAP = 3;
