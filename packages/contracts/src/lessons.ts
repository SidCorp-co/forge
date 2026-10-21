// One declaration of the lessons vocabulary (REQ-50, docs/proposals/lessons.md): core's table CHECKs,
// REST and the web import the sources, scopes, statuses, limits, refusal codes, request schemas and
// views from here.

import { z } from "zod";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";
import type { RefusalStatuses } from "./refusal.js";

/** Where a correction was said (BC-1). */
export const CORRECTION_SOURCES = [
	"mockup_returned",
	"mockup_accepted",
	"suggestion_rejected",
	"design_returned",
	"revision_returned",
	"verdict_failed",
	"chat",
] as const;
export type CorrectionSource = (typeof CORRECTION_SOURCES)[number];

export const CORRECTION_SOURCE_LABELS: Record<CorrectionSource, string> = {
	mockup_returned: "Mockup returned",
	mockup_accepted: "Mockup accepted",
	suggestion_rejected: "Suggestion rejected",
	design_returned: "Design returned",
	revision_returned: "Revision returned",
	verdict_failed: "Verdict failed",
	chat: "Chat",
};

/** The item a correction is about. */
export const CORRECTION_ITEM_KINDS = [
	"mockup",
	"suggestion",
	"workflow",
	"requirement",
	"issue",
	"conversation",
] as const;
export type CorrectionItemKind = (typeof CORRECTION_ITEM_KINDS)[number];

/** The kinds of output an agent produces, which an `item_kind` lesson is scoped to. */
export const LESSON_ITEM_KINDS = [
	"requirement",
	"workflow",
	"mockup",
	"suggestion",
	"issue",
	"chat",
] as const;
export type LessonItemKind = (typeof LESSON_ITEM_KINDS)[number];

export const LESSON_SCOPE_KINDS = ["project", "area", "item_kind"] as const;
export type LessonScopeKind = (typeof LESSON_SCOPE_KINDS)[number];

export const LESSON_STATUSES = [
	"proposed",
	"approved",
	"held",
	"rejected",
	"retired",
] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export const LESSON_STATUS_LABELS: Record<LessonStatus, string> = {
	proposed: "Proposed",
	approved: "Approved",
	held: "Held",
	rejected: "Rejected",
	retired: "Retired",
};

/** What an agent found confusing about a lesson (BC-5). */
export const LESSON_CONFUSION_KINDS = [
	"conflict",
	"contradicts",
	"unclear",
	"wrongly_applied",
] as const;
export type LessonConfusionKind = (typeof LESSON_CONFUSION_KINDS)[number];

export const LESSON_CONFUSION_LABELS: Record<LessonConfusionKind, string> = {
	conflict: "Conflicts with a lesson",
	contradicts: "Contradicts the design",
	unclear: "Unclear how it applies",
	wrongly_applied: "Wrongly applied",
};

/** How a confusion is decided. */
export const LESSON_RESOLUTIONS = ["keep", "edit", "retire"] as const;
export type LessonResolution = (typeof LESSON_RESOLUTIONS)[number];

/** The outputs an applied lesson is recorded against (BC-4). */
export const LESSON_OUTPUT_KINDS = [
	"chat_message",
	"steward_run",
	"job",
	"issue",
] as const;
export type LessonOutputKind = (typeof LESSON_OUTPUT_KINDS)[number];

/** Why the lessons pass proposes retiring one (BC-7). */
export const LESSON_RETIRE_REASONS = ["superseded", "unused"] as const;
export type LessonRetireReason = (typeof LESSON_RETIRE_REASONS)[number];

/** A chat reply is kept as a correction only at or above this classifier confidence. */
export const CHAT_CORRECTION_THRESHOLD = 0.7;
/** Similar corrections a proposal groups at the least (BC-2). */
export const LESSON_PROPOSE_MIN = 2;
/** Linked corrections that make a lesson a check (BC-6). */
export const LESSON_CHECK_AFTER = 3;
/** Days unused before the pass proposes retiring a lesson (BC-7). */
export const LESSON_UNUSED_DAYS = 30;
/** How often the steward's lessons pass runs. */
export const LESSONS_PASS_MS = 10 * 60_000;

export const LESSON_LIMITS = {
	sentenceChars: 240,
	reasonChars: 2000,
	sideChars: 400,
	appliedPerOutput: 20,
	correctionsPerLesson: 50,
} as const;

export const lessonKey = (number: number) => `L-${number}`;

/** The line an output ends with when lessons shaped it: `Lessons applied: L-3, L-7`. */
const APPLIED_LINE = /^\s*Lessons applied:\s*(L-\d+(?:\s*,\s*L-\d+)*)\s*\.?\s*$/im;

/** The lesson numbers an output's `Lessons applied:` line names, in order, once each. */
export function appliedLessonsIn(text: string): number[] {
	const line = APPLIED_LINE.exec(text);
	if (!line?.[1]) return [];
	const numbers = line[1].split(",").map((k) => Number(k.trim().slice(2)));
	return [...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0))];
}

export const LESSON_REFUSAL_CODES = [
	"LESSON_REFUSED",
	"LESSON_NOT_FOUND",
	"LESSON_DECIDED",
	"LESSON_NOT_APPLICABLE",
	"LESSON_SCOPE_INVALID",
	"LESSON_CORRECTIONS_INVALID",
	"LESSON_CONFUSION_INVALID",
	"LESSON_CONFUSION_DECIDED",
	"LESSON_APPLICATION_MARKED",
	"CORRECTION_NOT_FOUND",
	...PERMISSION_REFUSAL_CODES,
] as const;
export type LessonRefusalCode = (typeof LESSON_REFUSAL_CODES)[number];

/** Codes that answer other than 422; a `_FORBIDDEN` code answers 403 unlisted. */
export const LESSON_REFUSAL_STATUSES = {
	LESSON_NOT_FOUND: 404,
	CORRECTION_NOT_FOUND: 404,
	LESSON_DECIDED: 409,
	LESSON_CONFUSION_DECIDED: 409,
	LESSON_APPLICATION_MARKED: 409,
} as const satisfies RefusalStatuses<LessonRefusalCode>;

const sentence = z.string().trim().min(1).max(LESSON_LIMITS.sentenceChars);
const reason = z.string().trim().min(1).max(LESSON_LIMITS.reasonChars);
const lessonNumber = z.number().int().min(1);

export const lessonScopeSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("project") }),
	z.strictObject({ kind: z.literal("area"), areaId: z.uuid() }),
	z.strictObject({
		kind: z.literal("item_kind"),
		itemKind: z.enum(LESSON_ITEM_KINDS),
	}),
]);
export type LessonScope = z.infer<typeof lessonScopeSchema>;
const SCOPE_SHAPE =
	"{ kind: project } | { kind: area, areaId } | { kind: item_kind, itemKind: requirement | workflow | mockup | suggestion | issue | chat }";

/** `POST /api/projects/:id/lessons`: a proposal grouping the corrections it learns from. */
export const proposeLessonRequestSchema = z.strictObject({
	sentence,
	scope: lessonScopeSchema,
	corrections: z
		.array(z.uuid())
		.min(1)
		.max(LESSON_LIMITS.correctionsPerLesson),
	supersedes: lessonNumber.optional(),
});
export type ProposeLessonRequest = z.infer<typeof proposeLessonRequestSchema>;
export const PROPOSE_LESSON_SHAPE = `{ sentence, scope: ${SCOPE_SHAPE}, corrections: [correction uuid], supersedes?: lesson number }`;

/** `PATCH …/lessons/:n` (proposed) and `POST …/lessons/:n/approve`: the edit a person makes. */
export const editLessonRequestSchema = z.strictObject({
	sentence: sentence.optional(),
	scope: lessonScopeSchema.optional(),
});
export type EditLessonRequest = z.infer<typeof editLessonRequestSchema>;
export const EDIT_LESSON_SHAPE = `{ sentence?, scope?: ${SCOPE_SHAPE} }`;

/** `POST …/lessons/:n/reject | retire`, and marking an application wrongly applied. */
export const lessonReasonRequestSchema = z.strictObject({ reason });
export const LESSON_REASON_SHAPE = "{ reason }";

/** `POST /api/projects/:id/lessons/applied`: the lessons one output applied. */
export const recordAppliedRequestSchema = z.strictObject({
	lessons: z
		.array(lessonNumber)
		.min(1)
		.max(LESSON_LIMITS.appliedPerOutput),
	output: z.strictObject({
		kind: z.enum(LESSON_OUTPUT_KINDS),
		ref: z.string().trim().min(1).max(200),
	}),
});
export type RecordAppliedRequest = z.infer<typeof recordAppliedRequestSchema>;
export const RECORD_APPLIED_SHAPE =
	"{ lessons: [lesson number], output: { kind: chat_message | steward_run | job | issue, ref } }";

const side = z.string().trim().min(1).max(LESSON_LIMITS.sideChars);

/** `POST …/lessons/:n/confusions`: an agent stops guessing and asks (BC-5). */
export const raiseConfusionRequestSchema = z.strictObject({
	kind: z.enum(LESSON_CONFUSION_KINDS),
	other: z
		.strictObject({
			lesson: lessonNumber.optional(),
			ref: z.string().trim().min(1).max(120).optional(),
		})
		.optional(),
	sides: z.strictObject({ lesson: side, other: side }),
	recommended: z.strictObject({
		resolution: z.enum(LESSON_RESOLUTIONS),
		sentence: sentence.optional(),
	}),
});
export type RaiseConfusionRequest = z.infer<typeof raiseConfusionRequestSchema>;
export const RAISE_CONFUSION_SHAPE =
	"{ kind: conflict | contradicts | unclear | wrongly_applied, other?: { lesson?, ref? }, sides: { lesson, other }, recommended: { resolution: keep | edit | retire, sentence? } }";

/** `POST …/lessons/confusions/:cid/decide`. */
export const decideConfusionRequestSchema = z.strictObject({
	resolution: z.enum(LESSON_RESOLUTIONS),
	sentence: sentence.optional(),
});
export type DecideConfusionRequest = z.infer<typeof decideConfusionRequestSchema>;
export const DECIDE_CONFUSION_SHAPE =
	"{ resolution: keep | edit | retire, sentence? (edit needs one) }";

/** `GET …/lessons/month?month=YYYY-MM`. */
export const lessonsMonthQuerySchema = z.strictObject({
	month: z
		.string()
		.regex(/^\d{4}-(0[1-9]|1[0-2])$/)
		.optional(),
});

export interface LessonPerson {
	id: string;
	name: string | null;
}

export interface CorrectionView {
	id: string;
	source: CorrectionSource;
	item: {
		kind: CorrectionItemKind;
		id: string;
		key: string;
		title: string | null;
	};
	reason: string;
	by: LessonPerson | null;
	agency: "human" | "agent";
	at: string;
	lessonKey: string | null;
	/** The classifier's confidence, on a chat correction. */
	score: number | null;
	dismissed: boolean;
}

export interface LessonScopeView {
	kind: LessonScopeKind;
	areaId: string | null;
	areaName: string | null;
	itemKind: LessonItemKind | null;
}

export interface ConfusionView {
	id: string;
	lessonKey: string;
	kind: LessonConfusionKind;
	other: { lessonKey: string | null; ref: string | null };
	sides: { lesson: string; other: string };
	recommended: { resolution: LessonResolution; sentence: string | null };
	raisedBy: LessonPerson | null;
	raisedAgency: "human" | "agent";
	raisedAt: string;
	decidedBy: LessonPerson | null;
	decidedAt: string | null;
	resolution: LessonResolution | null;
}

export interface ApplicationView {
	id: string;
	lessonKey: string;
	output: { kind: LessonOutputKind; ref: string };
	agent: LessonPerson | null;
	at: string;
	wrong: { by: LessonPerson | null; at: string; reason: string } | null;
}

export interface LessonView {
	id: string;
	key: string;
	number: number;
	sentence: string;
	scope: LessonScopeView;
	status: LessonStatus;
	proposedBy: LessonPerson | null;
	proposedAt: string;
	approvedAt: string | null;
	/** Why it was rejected or retired. */
	reason: string | null;
	/** Provenance: each correction it learned from or that repeated it. */
	corrections: CorrectionView[];
	repeats: number;
	appliedCount: number;
	lastAppliedAt: string | null;
	retire: { reason: LessonRetireReason; at: string } | null;
	supersedes: string | null;
	supersededBy: string | null;
	checkIssueKey: string | null;
	confusions: ConfusionView[];
	applications: ApplicationView[];
	can: {
		approve: boolean;
		reject: boolean;
		edit: boolean;
		retire: boolean;
		keep: boolean;
	};
}

export interface LessonsResponse {
	lessons: LessonView[];
	/** Corrections no lesson holds yet, newest first. */
	corrections: CorrectionView[];
	/** Every open confusion, oldest first: each is a decision a person owes. */
	confusions: ConfusionView[];
	canDecide: boolean;
}

export interface LessonResponse {
	lesson: LessonView;
}

export interface LessonsMonthView {
	month: string;
	corrections: {
		total: number;
		bySource: Record<CorrectionSource, number>;
	};
	lessonsApproved: number;
	repeats: number;
	confusions: {
		raised: number;
		decided: number;
		open: number;
		items: Array<{
			id: string;
			lessonKey: string;
			kind: LessonConfusionKind;
			raisedAt: string;
			decidedAt: string | null;
			/** Hours from raise to decision, or to now while open. */
			hours: number;
		}>;
	};
}

/** The outbox events the lessons module reads. */
export interface LessonEventPayloads {
	/** A person's message followed an assistant turn in a project chat (BC-1, chat source). */
	"chat.replied": {
		projectId: string;
		conversationId: string;
		assistantMessageId: string;
		personMessageId: string;
	};
}

/** `GET /api/projects/:id/lessons/chat/:conversationId`: the lines a chat draws for lessons. */
export interface ChatLessonMarks {
	/** A person's reply kept as a correction, keyed by that reply's message id. */
	corrections: Array<{
		id: string;
		messageId: string;
		reason: string;
		dismissed: boolean;
	}>;
	/** A lesson an assistant message applied, keyed by that message's id. */
	applied: Array<{
		id: string;
		messageId: string;
		lessonKey: string;
		wrong: boolean;
	}>;
}
