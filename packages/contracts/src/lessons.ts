// One declaration of the lessons vocabulary (REQ-50, docs/proposals/lessons.md): core's table CHECKs
// and the agents' REST doors import the sources, scopes, statuses, limits, refusal codes and request
// schemas from here. Lessons are internal to Forge (REQ-50 BC-9): agents and core read them, and no
// screen shows one to a person, so nothing here is a view for one.

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


/** What an agent found confusing about a lesson (BC-5). */
export const LESSON_CONFUSION_KINDS = [
	"conflict",
	"contradicts",
	"unclear",
	"wrongly_applied",
] as const;
export type LessonConfusionKind = (typeof LESSON_CONFUSION_KINDS)[number];


/** How the steward settles a confusion. */
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

/** Why a lesson was proposed for retirement, on a row written before the steward retired them itself (BC-7). */
export const LESSON_RETIRE_REASONS = ["superseded", "unused"] as const;
export type LessonRetireReason = (typeof LESSON_RETIRE_REASONS)[number];

/** A chat reply is kept as a correction only at or above this classifier confidence. */
export const CHAT_CORRECTION_THRESHOLD = 0.7;
/** Similar corrections a proposal groups at the least (BC-2). */
export const LESSON_PROPOSE_MIN = 2;
/** Linked corrections that make a lesson a check (BC-6). */
export const LESSON_CHECK_AFTER = 3;
/** Days unused before the steward retires a lesson (BC-7). */
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
const APPLIED_LINE =
	/^\s*Lessons applied:\s*(L-\d+(?:\s*,\s*L-\d+)*)\s*\.?\s*$/im;

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
	...PERMISSION_REFUSAL_CODES,
] as const;
export type LessonRefusalCode = (typeof LESSON_REFUSAL_CODES)[number];

/** Codes that answer other than 422; a `_FORBIDDEN` code answers 403 unlisted. */
export const LESSON_REFUSAL_STATUSES = {
	LESSON_NOT_FOUND: 404,
	LESSON_DECIDED: 409,
	LESSON_CONFUSION_DECIDED: 409,
	LESSON_APPLICATION_MARKED: 409,
} as const satisfies RefusalStatuses<LessonRefusalCode>;

const sentence = z.string().trim().min(1).max(LESSON_LIMITS.sentenceChars);
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

/** A proposal the steward makes, grouping the corrections it learns from (BC-2). */
export const proposeLessonRequestSchema = z.strictObject({
	sentence,
	scope: lessonScopeSchema,
	corrections: z.array(z.uuid()).min(1).max(LESSON_LIMITS.correctionsPerLesson),
	supersedes: lessonNumber.optional(),
});
export type ProposeLessonRequest = z.infer<typeof proposeLessonRequestSchema>;

/** `POST /api/projects/:id/lessons/applied`: the lessons one output applied. */
export const recordAppliedRequestSchema = z.strictObject({
	lessons: z.array(lessonNumber).min(1).max(LESSON_LIMITS.appliedPerOutput),
	output: z.strictObject({
		kind: z.enum(LESSON_OUTPUT_KINDS),
		ref: z.string().trim().min(1).max(200),
	}),
});
export type RecordAppliedRequest = z.infer<typeof recordAppliedRequestSchema>;
export const RECORD_APPLIED_SHAPE =
	"{ lessons: [lesson number], output: { kind: chat_message | steward_run | job | issue, ref } }";

const side = z.string().trim().min(1).max(LESSON_LIMITS.sideChars);

/** `POST …/lessons/:n/confusions`: an agent stops guessing and reports it to the steward (BC-5). */
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
	"{ kind: conflict | contradicts | unclear | wrongly_applied, other?: { lesson?, ref? }, sides: { lesson, other }, recommended: { resolution: keep | edit | retire, sentence? } } (a wrongly_applied names its output in other.ref)";

/** What raising a confusion answers: the lesson it holds, as it now stands. */
export interface RaiseConfusionResponse {
	lesson: { key: string; status: LessonStatus };
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
