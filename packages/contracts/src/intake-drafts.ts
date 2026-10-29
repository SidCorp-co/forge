// The intake assistant's draft (REQ-34 BC-4, BC-10..BC-16; designs feedback-triage r16 `intake`,
// `dedup`, `suggest` and requirement-lifecycle r15 `start`, `draft`). Creating a requirement or filing
// feedback starts it with no chat. It reads the product record only (requirements, workflows,
// feedback, releases), never the codebase or an issue; names what the item duplicates, conflicts
// with, affects and relates to, each linked; fills each gap it can as an assumption naming its
// source; and asks at most three questions that change scope or outcome, each with a recommended
// answer and what each choice changes, or says it has nothing to ask. Core keeps one draft per item
// (`core/src/intake/`); the item's page shows it.
//
// The draft carries the item's one value check (REQ-65 BC-1..BC-6, REQ-66 BC-2): who it is for, what
// improves, how that is measured and whether it already exists, ending as accept, merge into an
// existing item, a better alternative, or refuse with a one-line reason. Only a missing problem or
// value, or a contradicted criterion, holds the check on a question; every other gap takes its
// question's recommended answer as an assumption. A person answers a question (`POST
// …/intake-drafts/:ref/answers`) and keeps a refused requirement with a one-line reason (`POST
// …/intake-drafts/:ref/keep`).

import { z } from "zod";
import type { RefusalStatuses } from "./refusal.js";

export const INTAKE_ITEM_KINDS = ["requirement", "feedback"] as const;
export type IntakeItemKind = (typeof INTAKE_ITEM_KINDS)[number];

/** The only records a draft reads (BC-11). An issue and the codebase are not among them. */
export const INTAKE_READS = [
	"requirements",
	"workflows",
	"feedback",
	"releases",
] as const;
export type IntakeRead = (typeof INTAKE_READS)[number];

/** What a link or a source names: one record of the four reads. */
export const INTAKE_REF_KINDS = [
	"requirement",
	"workflow",
	"feedback",
	"release",
] as const;
export type IntakeRefKind = (typeof INTAKE_REF_KINDS)[number];

export const INTAKE_LINK_RELATIONS = [
	"duplicate",
	"conflict",
	"affected_workflow",
	"related_feedback",
] as const;
export type IntakeLinkRelation = (typeof INTAKE_LINK_RELATIONS)[number];

/** The record kinds each relation may link (BC-12): a duplicate is of the item's own kind. */
export const INTAKE_LINK_TARGETS: Record<
	IntakeLinkRelation,
	readonly IntakeRefKind[]
> = {
	duplicate: ["requirement", "feedback"],
	conflict: ["requirement"],
	affected_workflow: ["workflow"],
	related_feedback: ["feedback"],
};

/** The answers a draft may fill, per item kind; each fill is shown as an assumption (BC-13). */
export const INTAKE_FIELDS = {
	requirement: [
		"summary",
		"goal",
		"persona",
		"in_scope",
		"out_of_scope",
		"criterion",
	],
	feedback: [
		"kind",
		"severity",
		"requirement",
		"criterion",
		"reproduced",
		"route",
	],
} as const satisfies Record<IntakeItemKind, readonly string[]>;
export type IntakeField = (typeof INTAKE_FIELDS)[IntakeItemKind][number];

/** At most three questions (BC-14), each changing one of these (BC-14). */
export const INTAKE_QUESTIONS_MAX = 3;
export const INTAKE_QUESTION_CHANGES = ["scope", "outcome"] as const;
export type IntakeQuestionChange = (typeof INTAKE_QUESTION_CHANGES)[number];

/** What the value check states of every request (REQ-65 BC-1): whose problem, what improves, how it is measured. */
export const VALUE_FACTS = ["who", "improves", "measured"] as const;
export type ValueFact = (typeof VALUE_FACTS)[number];

/** How the value check ends (REQ-65 BC-2). */
export const VALUE_OUTCOMES = ["accept", "merge", "alternative", "refuse"] as const;
export type ValueOutcome = (typeof VALUE_OUTCOMES)[number];

/**
 * What alone may hold the check on a question (REQ-65 BC-4): a missing problem (whose it is), a
 * missing value (what improves), or a current criterion the request contradicts.
 */
export const VALUE_BLOCKS = ["problem", "value", "criterion"] as const;
export type ValueBlock = (typeof VALUE_BLOCKS)[number];

/** The source a fact names when it is a question's recommended answer, taken while unanswered (REQ-65 BC-5). */
export const RECOMMENDED_SOURCE = /^question:([1-3])$/;

export const INTAKE_LIMITS = {
	fills: 24,
	links: 12,
	value: 1000,
	why: 200,
	quote: 300,
	prompt: 300,
	optionLabel: 120,
	effect: 200,
	nothingToAsk: 200,
	optionsMin: 2,
	optionsMax: 4,
	/** A refusal's reason, an alternative, a keep's reason: one line. */
	line: 150,
	fact: 300,
} as const;

/** One line of text: no line break, at most `max` characters. */
export const oneLineText = (max: number) =>
	z
		.string()
		.trim()
		.min(1)
		.max(max)
		.regex(/^[^\r\n]*$/, "one line: no line break");

const OPTION_ID = /^[a-z0-9_-]{1,32}$/;

const intakeOptionSchema = z.strictObject({
	id: z.string().regex(OPTION_ID, "an option id is 1-32 of a-z, 0-9, _ and -"),
	label: z.string().trim().min(1).max(INTAKE_LIMITS.optionLabel),
	/** What choosing it changes (BC-15). */
	effect: z.string().trim().min(1).max(INTAKE_LIMITS.effect),
});

const intakeQuestionSchema = z.strictObject({
	prompt: z.string().trim().min(5).max(INTAKE_LIMITS.prompt),
	changes: z.enum(INTAKE_QUESTION_CHANGES),
	options: z
		.array(intakeOptionSchema)
		.min(INTAKE_LIMITS.optionsMin)
		.max(INTAKE_LIMITS.optionsMax),
	/** The id of the option the assistant recommends (BC-15). */
	recommended: z.string().min(1),
	/** What the question holds the value check on, or null where its recommended answer is taken (REQ-65 BC-4, BC-5). */
	blocks: z.enum(VALUE_BLOCKS).nullable().default(null),
});
export type IntakeQuestion = z.infer<typeof intakeQuestionSchema>;

const valueFactSchema = z.strictObject({
	value: z.string().trim().min(1).max(INTAKE_LIMITS.fact),
	/** The item's own key, a ref shown in the record, or `question:N` for question N's recommended answer. */
	source: z.string().trim().min(1).max(200),
});

const valueOutcomeSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("accept") }),
	z.strictObject({
		kind: z.literal("merge"),
		/** The existing item it joins: the ref `exists` names. */
		into: z.string().trim().min(1).max(200),
		why: oneLineText(INTAKE_LIMITS.line),
	}),
	z.strictObject({
		kind: z.literal("alternative"),
		instead: oneLineText(INTAKE_LIMITS.line),
		/** A record the alternative rests on, where one does. */
		ref: z.string().trim().min(1).max(200).nullable().default(null),
	}),
	z.strictObject({ kind: z.literal("refuse"), reason: oneLineText(INTAKE_LIMITS.line) }),
]);

/**
 * The value check as the model answers it. A fact is null where the item and the record leave it
 * open; `exists` names the item it repeats, or is null; `outcome` is null exactly while a blocking
 * question holds the check.
 */
export const valueCheckAnswerSchema = z.strictObject({
	who: valueFactSchema.nullable(),
	improves: valueFactSchema.nullable(),
	measured: valueFactSchema.nullable(),
	exists: z
		.strictObject({
			ref: z.string().trim().min(1).max(200),
			why: oneLineText(INTAKE_LIMITS.line),
		})
		.nullable(),
	outcome: valueOutcomeSchema.nullable(),
});
export type ValueCheckAnswer = z.infer<typeof valueCheckAnswerSchema>;

/**
 * What the model answers with. A `source` and a link's `ref` name a record by the ref the draft was
 * shown it under; core judges them against what it read (`core/src/intake/rules.ts`). A link carries
 * its basis, both quoted word for word from what was shown: `basis`, the linked record's own words
 * (a conflict's contradicted criterion, an affected workflow's step, the words a duplicate or related
 * item shares), and `itemQuote`, the item's words it rests on. `notAffected` says why a workflow core
 * offered as touched is not affected. `triage` is a feedback draft's checklist as a
 * `feedback_triage` suggestion payload, and absent on a requirement.
 */
export const intakeAnswerSchema = z.strictObject({
	fills: z
		.array(
			z.strictObject({
				field: z.string().min(1).max(40),
				value: z.string().trim().min(1).max(INTAKE_LIMITS.value),
				source: z.string().trim().min(1).max(200),
			}),
		)
		.max(INTAKE_LIMITS.fills),
	links: z
		.array(
			z.strictObject({
				relation: z.enum(INTAKE_LINK_RELATIONS),
				ref: z.string().trim().min(1).max(200),
				why: z.string().trim().min(1).max(INTAKE_LIMITS.why),
				basis: z.string().trim().min(1).max(INTAKE_LIMITS.quote),
				itemQuote: z.string().trim().min(1).max(INTAKE_LIMITS.quote),
			}),
		)
		.max(INTAKE_LIMITS.links),
	notAffected: z
		.array(
			z.strictObject({
				ref: z.string().trim().min(1).max(200),
				why: z.string().trim().min(1).max(INTAKE_LIMITS.why),
			}),
		)
		.max(INTAKE_LIMITS.links)
		.default([]),
	questions: z.array(intakeQuestionSchema).max(INTAKE_QUESTIONS_MAX),
	/** Said, in one line, exactly when `questions` is empty (BC-16). */
	nothingToAsk: z.string().trim().min(1).max(INTAKE_LIMITS.nothingToAsk).nullable(),
	value: valueCheckAnswerSchema,
	triage: z.unknown().optional(),
});
export type IntakeAnswer = z.infer<typeof intakeAnswerSchema>;

/** Why no draft was made, kept on the item by name. */
export const INTAKE_DRAFT_CODES = [
	"INTAKE_MODEL_UNCONFIGURED",
	"INTAKE_WITHHELD",
	"INTAKE_MODEL_FAILED",
	"INTAKE_SHAPE",
] as const;
export type IntakeDraftCode = (typeof INTAKE_DRAFT_CODES)[number];

export const INTAKE_DRAFT_OUTCOMES = ["drafted", "failed"] as const;
export type IntakeDraftOutcome = (typeof INTAKE_DRAFT_OUTCOMES)[number];

/**
 * The misses tried again, by the outbox delivering the item's event once more with its backoff, up
 * to `INTAKE_DRAFT_ATTEMPTS` tries in all; every other miss is final on its first try.
 */
export const INTAKE_RETRYABLE_CODES: readonly IntakeDraftCode[] = [
	"INTAKE_MODEL_FAILED",
	"INTAKE_MODEL_UNCONFIGURED",
];
export const INTAKE_DRAFT_ATTEMPTS = 3;

/** One record a draft names: its kind, its key (REQ-n, FB-n, a workflow's flow, a release's version) and title. */
export interface IntakeDraftRef {
	kind: IntakeRefKind;
	key: string;
	title: string;
}

/** What a link rests on, as read: the record's words and the item's, and the criterion or step they are. */
export interface IntakeLinkBasis {
	quote: string;
	itemQuote: string;
	/** A conflict's contradicted criterion (BC-n of the linked requirement). */
	criterion?: string;
	/** An affected workflow's step, by its label. */
	step?: string;
}

export interface IntakeDraftLink {
	relation: IntakeLinkRelation;
	ref: IntakeDraftRef;
	why: string;
	/** Absent on a draft kept before a link carried its basis. */
	basis?: IntakeLinkBasis;
}

/** A workflow core offered as touched by the item's words, and why the draft says it is not affected. */
export interface IntakeDraftUnaffected {
	ref: IntakeDraftRef;
	why: string;
}

/** A gap the draft filled, stated as an assumption naming the record it came from (BC-13). */
export interface IntakeDraftAssumption {
	field: IntakeField;
	value: string;
	/** The item itself (its own words) or one record it read. */
	source: IntakeDraftRef;
}

/** What the draft was written as: the requirement's open draft, a triage suggestion, or neither and why. */
export type IntakeDraftApplied =
	| { as: "revision"; revision: number; fields: IntakeField[] }
	| { as: "suggestion"; suggestionId: string }
	| { as: "none"; code: string; detail: string };

/**
 * Where a value fact came from: the item's own words, a record it read, a question's recommended
 * answer taken while it stands unanswered, or the answer a person gave that question, which replaces
 * the recommended one it stood in for (REQ-65 BC-5).
 */
export type ValueFactSource =
	| IntakeDraftRef
	| { kind: "recommended"; question: number }
	| { kind: "answer"; question: number };

export interface ValueFactView {
	value: string;
	source: ValueFactSource;
}

export type ValueOutcomeView =
	| { kind: "accept" }
	| { kind: "merge"; into: IntakeDraftRef; why: string }
	| { kind: "alternative"; instead: string; ref: IntakeDraftRef | null }
	| { kind: "refuse"; reason: string };

/** What a requirement's value check wrote: its move to refused, a duplicate suggestion, or neither and why. */
export type ValueEffect =
	| { as: "refused" }
	| { as: "suggestion"; suggestionId: string }
	| { as: "none"; code: string; detail: string };

/** The one value check of a request (REQ-65 BC-1, BC-2). */
export interface ValueCheckView {
	who: ValueFactView | null;
	improves: ValueFactView | null;
	measured: ValueFactView | null;
	exists: { ref: IntakeDraftRef; why: string } | null;
	/** Null while a blocking question holds it. */
	outcome: ValueOutcomeView | null;
	/** A refused requirement a person kept anyway, with their one-line reason (REQ-65 BC-6). */
	kept: { reason: string; by: { id: string; name: string | null }; at: string } | null;
	/** What a requirement's check wrote; null on a feedback item, whose triage is `applied`. */
	effect: ValueEffect | null;
}

/** A question as the item's page shows it: whether it holds the check, and the answer given. */
export interface IntakeQuestionView extends IntakeQuestion {
	/** 1-based: what an answer names it by. */
	number: number;
	answer: { option: string; label: string; by: { id: string; name: string | null }; at: string } | null;
}

/** A question answered on an earlier draft, as asked and answered. */
export interface IntakeAnsweredView {
	prompt: string;
	label: string;
	by: { id: string; name: string | null };
	at: string;
}

export interface IntakeDraftView {
	item: { kind: IntakeItemKind; key: string };
	outcome: IntakeDraftOutcome;
	/** Set on `failed`: why no draft was made. */
	code: IntakeDraftCode | null;
	detail: string | null;
	at: string;
	model: string | null;
	attempts: number;
	/** Set on a `failed` draft another try is owed for: the outbox delivers it again. */
	retrying: boolean;
	/** How many records of each kind it read; no other kind is read. */
	read: Record<IntakeRead, number>;
	links: IntakeDraftLink[];
	/** Workflows the item's words touch that the draft says it does not affect, each with why. */
	notAffected: IntakeDraftUnaffected[];
	assumptions: IntakeDraftAssumption[];
	questions: IntakeQuestionView[];
	/** Questions answered before this draft was made, which it was drafted with. */
	answered: IntakeAnsweredView[];
	/** Set exactly when it asks nothing (BC-16). */
	nothingToAsk: string | null;
	applied: IntakeDraftApplied | null;
	/** The value check; null on a draft made before the check, or one that failed. */
	value: ValueCheckView | null;
	/** Whether the viewer may answer its questions and keep it once refused. */
	can: { answer: boolean; keep: boolean };
}

/** `GET /api/projects/:id/intake-drafts/:ref`: the item's draft, or null while none was made. */
export interface IntakeDraftResponse {
	draft: IntakeDraftView | null;
}

/** `POST /api/projects/:id/intake-drafts/:ref/answers`: one option of one question, by its number. */
export const intakeAnswerRequestSchema = z.strictObject({
	question: z.number().int().min(1).max(INTAKE_QUESTIONS_MAX),
	option: z.string().regex(OPTION_ID, "an option id is 1-32 of a-z, 0-9, _ and -"),
});
export type IntakeAnswerRequest = z.infer<typeof intakeAnswerRequestSchema>;
export const INTAKE_ANSWER_SHAPE = `{ question: 1-${INTAKE_QUESTIONS_MAX}, option: <option id> }`;

/** `POST /api/projects/:id/intake-drafts/:ref/keep`: a refused request kept, with a one-line reason. */
export const intakeKeepRequestSchema = z.strictObject({
	reason: oneLineText(INTAKE_LIMITS.line),
});
export type IntakeKeepRequest = z.infer<typeof intakeKeepRequestSchema>;
export const INTAKE_KEEP_SHAPE = `{ reason: one line, at most ${INTAKE_LIMITS.line} characters }`;

export const INTAKE_REFUSAL_CODES = [
	"INTAKE_REF_INVALID",
	"INTAKE_NOT_DRAFTED",
	"INTAKE_QUESTION_UNKNOWN",
	"VALUE_CHECK_NOT_REFUSED",
] as const;
export type IntakeRefusalCode = (typeof INTAKE_REFUSAL_CODES)[number];
export const INTAKE_REFUSAL_STATUSES = {
	INTAKE_REF_INVALID: 400,
	INTAKE_NOT_DRAFTED: 409,
	INTAKE_QUESTION_UNKNOWN: 400,
	VALUE_CHECK_NOT_REFUSED: 409,
} as const satisfies RefusalStatuses<IntakeRefusalCode>;

/** The item a ref names: REQ-n is a requirement, FB-n a feedback item; null for anything else. */
export function intakeItemOfRef(
	ref: string,
): { kind: IntakeItemKind; seq: number } | null {
	const m = /^(REQ|FB)-([1-9][0-9]{0,8})$/i.exec(ref.trim());
	if (!m) return null;
	return {
		kind: (m[1] as string).toUpperCase() === "REQ" ? "requirement" : "feedback",
		seq: Number(m[2]),
	};
}

/**
 * The ref a record is shown to the model under and an assumption's `source` names it by: REQ-n,
 * FB-n, `workflow:<flow>` or `release:<version>`.
 */
export function intakeRefOf(ref: { kind: IntakeRefKind; key: string }): string {
	if (ref.kind === "workflow") return `workflow:${ref.key}`;
	if (ref.kind === "release") return `release:${ref.key}`;
	return ref.key;
}

/** The record a ref names, or null for text that is no ref. */
export function intakeRefParse(
	ref: string,
): { kind: IntakeRefKind; key: string } | null {
	const prefixed = /^(workflow|release):(.+)$/.exec(ref);
	if (prefixed) {
		return {
			kind: prefixed[1] as "workflow" | "release",
			key: prefixed[2] as string,
		};
	}
	if (/^REQ-[1-9][0-9]*$/.test(ref)) return { kind: "requirement", key: ref };
	if (/^FB-[1-9][0-9]*$/.test(ref)) return { kind: "feedback", key: ref };
	return null;
}
