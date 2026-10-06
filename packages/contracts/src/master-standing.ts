// one declaration of what a project master is doing (design agent-run-standing rev 1, region master,
// edge master.declared; REQ-15 BC-6, ISS-106): the runner declares its slots and opens and closes each pass,
// core stores them, and `GET /api/projects/:id/masters/standing` serves them so no screen guesses.

import { z } from "zod";

/** The path a `master.wake` frame points a master at. */
export function masterCharterPath(projectId: string): string {
	return `/api/projects/${projectId}/master-charter`;
}

export const MASTER_VERBS = [
	"triage",
	"dispatch",
	"fold",
	"judge",
	"release",
	"park",
] as const;
export type MasterVerb = (typeof MASTER_VERBS)[number];

/** What started a pass: a runner nudge, or a turn the runner saw start without one. */
export const MASTER_PASS_TRIGGERS = ["nudge", "unprompted"] as const;
export type MasterPassTrigger = (typeof MASTER_PASS_TRIGGERS)[number];

/** Why a pass's turn was refused before it ran, as the master's account said it. */
export const MASTER_PASS_REFUSAL_REASONS = [
	"usage_limit",
	"rate_limit",
	"auth",
] as const;

/**
 * How a pass ended, as the box that closed it judged it: `turn_ended` its turn ran and ended;
 * `abandoned_quiet` its master said nothing for the quiet bound; `abandoned_restart` the daemon that
 * opened it restarted; `abandoned_orphan` core held it open with no record on the box;
 * `session_gone` its master session is no longer the box's; `unrecorded` the box could not record the
 * open, so it closed it at once. A pass closed by a runner that predates the field reads `null`.
 */
export const MASTER_PASS_CLOSE_REASONS = [
	"turn_ended",
	"abandoned_quiet",
	"abandoned_restart",
	"abandoned_orphan",
	"session_gone",
	"unrecorded",
] as const;
export type MasterPassCloseReason = (typeof MASTER_PASS_CLOSE_REASONS)[number];

/** `runs_out`: no pass is open, and runs this master declared are still out (`runsOut`). */
export const MASTER_STATES = [
	"in_pass",
	"runs_out",
	"idle",
	"waiting_person",
	"silent",
	"none",
] as const;
export type MasterState = (typeof MASTER_STATES)[number];

const MASTER_REFUSAL_CODES = [
	"MASTER_SLOTS_UNDECLARED",
	"MASTER_PASS_ALREADY_OPEN",
	"MASTER_PASS_NOT_OPEN",
	"MASTER_SESSION_ENDED",
	"MASTER_PASS_REFUSED_WITH_WORK",
] as const;
export type MasterRefusalCode = (typeof MASTER_REFUSAL_CODES)[number];

export interface MasterRefusal {
	code: MasterRefusalCode;
	path: string;
	detail: string;
}

export const MASTER_JOB_PANES_MAX = 64;
const MASTER_PASS_LIST_MAX = 200;
const MASTER_PASS_ITEM_MAX = 200;
const MASTER_PASS_REFUSAL_MAX = 1000;
const MASTER_ISSUE_KEY_MAX = 64;
const MASTER_DIALOG_TEXT_MAX = 400;
export const MASTER_PASS_PAGE_DEFAULT = 20;
export const MASTER_PASS_PAGE_MAX = 100;

export const masterSessionRequestSchema = z.strictObject({
	projectId: z.uuid(),
	name: z.string().min(1).max(120),
	maxJobPanes: z.number().int().min(1).max(MASTER_JOB_PANES_MAX).optional(),
});
export const MASTER_SESSION_SHAPE = `{ projectId: uuid, name: string (1-120), maxJobPanes: integer 1-${MASTER_JOB_PANES_MAX} }`;

const passItem = z.string().trim().min(1).max(MASTER_PASS_ITEM_MAX);

export const masterPassSkipSchema = z.strictObject({
	issueKey: z.string().trim().min(1).max(MASTER_ISSUE_KEY_MAX),
	refusal: z.string().trim().min(1).max(MASTER_PASS_REFUSAL_MAX),
});
export type MasterPassSkip = z.infer<typeof masterPassSkipSchema>;

export const masterPassRefusalSchema = z.strictObject({
	reason: z.enum(MASTER_PASS_REFUSAL_REASONS),
	detail: z.string().trim().min(1).max(MASTER_PASS_REFUSAL_MAX),
});
export type MasterPassRefusal = z.infer<typeof masterPassRefusalSchema>;

export const masterPassRequestSchema = z.discriminatedUnion("op", [
	z.strictObject({
		op: z.literal("open"),
		sessionId: z.uuid(),
		verb: z.enum(MASTER_VERBS),
		issueKey: z
			.string()
			.trim()
			.min(1)
			.max(MASTER_ISSUE_KEY_MAX)
			.nullable()
			.optional(),
		trigger: z.enum(MASTER_PASS_TRIGGERS).optional(),
	}),
	z.strictObject({
		op: z.literal("close"),
		sessionId: z.uuid(),
		passId: z.uuid(),
		dispatched: z.array(passItem).max(MASTER_PASS_LIST_MAX),
		skipped: z.array(masterPassSkipSchema).max(MASTER_PASS_LIST_MAX),
		parked: z.array(passItem).max(MASTER_PASS_LIST_MAX),
		refused: masterPassRefusalSchema.nullable().optional(),
		// Priced amnesty: optional only because a runner older than this sends none, which is stored as
		// null and read as unstated; it ends once every paired runner sends it.
		closeReason: z.enum(MASTER_PASS_CLOSE_REASONS).optional(),
	}),
]);
export const MASTER_PASS_SHAPE = `{ op: "open", sessionId: uuid, verb: ${MASTER_VERBS.join(" | ")}, issueKey?: string | null, trigger?: ${MASTER_PASS_TRIGGERS.join(" | ")} (default nudge) } or { op: "close", sessionId: uuid, passId: uuid (the id the open answered), dispatched: string[], skipped: { issueKey, refusal }[], parked: string[], refused?: { reason: ${MASTER_PASS_REFUSAL_REASONS.join(" | ")}, detail } | null (a refused pass reports no work), closeReason?: ${MASTER_PASS_CLOSE_REASONS.join(" | ")} }`;

/** A dialog the master's pane stopped on, as the runner read it; `null` clears it. */
export const masterDialogRequestSchema = z.strictObject({
	sessionId: z.uuid(),
	dialog: z
		.strictObject({
			text: z.string().trim().min(1).max(MASTER_DIALOG_TEXT_MAX),
			source: z.enum(["pane", "hooks"]),
		})
		.nullable(),
});
export const MASTER_DIALOG_SHAPE = `{ sessionId: uuid, dialog: { text: string (1-${MASTER_DIALOG_TEXT_MAX}), source: "pane" | "hooks" } | null }`;

/** What the runner last reported its master's pane stopped on. */
export interface MasterPaneDialog {
	text: string;
	source: "pane" | "hooks";
	seenAt: string;
}

/** The person a master waits on: whoever can answer at its pane. */
export interface MasterWaitingOn {
	kind: "person";
	who: string;
	act: string;
	rule: "MASTER_PANE_DIALOG";
	since: string;
}

export interface MasterOpenPass {
	id: string;
	sessionId: string;
	verb: MasterVerb;
	startedAt: string;
	issueKey: string | null;
	trigger: MasterPassTrigger;
}

export interface MasterClosedPass extends MasterOpenPass {
	endedAt: string;
	dispatched: string[];
	skipped: MasterPassSkip[];
	parked: string[];
	/** Set when the pass's turn was refused before it ran; such a pass is never idle. */
	refused: MasterPassRefusal | null;
	/** How the box judged it ended; null when the runner that closed it predates the field. */
	closeReason: MasterPassCloseReason | null;
}

export type MasterPassView = MasterOpenPass | MasterClosedPass;

export interface MasterPassResponse {
	pass: MasterPassView;
}

export interface MasterSessionResponse {
	sessionId: string;
	name: string;
	created: boolean;
	maxJobPanes: number | null;
}

export interface MasterSlots {
	/** Job panes the box holds for pool jobs: the count `max` (devices.max_job_panes) caps. */
	inUse: number;
	max: number | null;
	/** Live run sessions the box declared (`forge-runner run declare`, a master's in-pane builders):
	 *  max_job_panes does not cap them, so they are served beside the slots, never inside them. */
	runs: number;
	undeclared: MasterRefusal | null;
}

export interface MasterStanding {
	generatedAt: string;
	projectId: string;
	state: MasterState;
	sessionId: string | null;
	/** The master session's own name, as the runner declared it. */
	name: string | null;
	device: { id: string; name: string } | null;
	since: string | null;
	pass: MasterOpenPass | null;
	lastPass: MasterClosedPass | null;
	slots: MasterSlots | null;
	/** Live run sessions this project's master declared on its box (`forge-runner run declare`), still out. */
	runsOut: number;
	lastBeatAt: string | null;
	silentAfterSeconds: number;
	/** Set while state is waiting_person: the pane is stopped on a dialog only a person answers. */
	waitingOn: MasterWaitingOn | null;
	/** Permission dialogs the box answered (denied) for this project's panes, as its last heartbeat
	 *  counted them; null where it reported none. */
	dialogsAnswered: MasterDialogsAnswered | null;
	/** Set while core judges the pane outdated and keeps it: how long, why, and what its replacement waits on. */
	outdated: MasterOutdated | null;
}

/**
 * An outdated master core keeps rather than replaces, as its last verdict judged it. Being outdated
 * decides replacement only: the pane is still driven, and `draining` says it takes no new run so
 * that what it holds runs out and its successor is placed.
 */
export interface MasterOutdated {
	/** When core first judged this pane outdated, unbroken since. */
	since: string;
	/** Why its build or plugins are not the ones its box would place now, as the box said it. */
	why: string;
	/** Every reason its replacement waits on, as the last verdict named them. */
	heldBy: string[];
	draining: boolean;
}

/** What the box's `PermissionRequest` hook answered for a project, read off the device's gate report. */
export interface MasterDialogsAnswered {
	/** A floor where `countIsFloor`: the box keeps a bounded record, never a lifetime total. */
	count: number;
	countIsFloor: boolean;
	firstAt: string | null;
	lastAt: string | null;
	/** The newest answer as the person reads it: `denied Bash: <command>`. */
	last: string | null;
	/** The subagent that asked last; null where the pane's lead asked. */
	lastAgent: string | null;
}

export interface MasterPassList {
	generatedAt: string;
	projectId: string;
	items: MasterPassView[];
	limit: number;
	hasMore: boolean;
	next: string | null;
}

export const NO_MASTER_SLOTS =
	"No live master serves this project, so no box has declared slots for it.";

/** What a project's slots line says when no live master declared slots for it; null when one did. */
export function slotsNoteOf(
	standing: Pick<MasterStanding, "slots">,
): string | null {
	if (!standing.slots) return NO_MASTER_SLOTS;
	return standing.slots.undeclared?.detail ?? null;
}
