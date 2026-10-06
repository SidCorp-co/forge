// cm:why one declaration of what a project master is doing (design agent-run-standing rev 1, region master,
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

export const MASTER_STATES = [
	"in_pass",
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
	}),
]);
export const MASTER_PASS_SHAPE = `{ op: "open", sessionId: uuid, verb: ${MASTER_VERBS.join(" | ")}, issueKey?: string | null, trigger?: ${MASTER_PASS_TRIGGERS.join(" | ")} (default nudge) } or { op: "close", sessionId: uuid, passId: uuid (the id the open answered), dispatched: string[], skipped: { issueKey, refusal }[], parked: string[], refused?: { reason: ${MASTER_PASS_REFUSAL_REASONS.join(" | ")}, detail } | null (a refused pass reports no work) }`;

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
	inUse: number;
	max: number | null;
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
	lastBeatAt: string | null;
	silentAfterSeconds: number;
	/** Set while state is waiting_person: the pane is stopped on a dialog only a person answers. */
	waitingOn: MasterWaitingOn | null;
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
