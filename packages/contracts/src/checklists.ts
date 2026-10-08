// A checklist: the questions a gated move asks (REQ-34 r2 BC-3). One definition is the source of the
// answers a move may carry (`answersSchemaOf`), the input an agent sends (`checklistInputOf`), the
// form a person fills (`checklistFormOf`) and the check the kernel runs under its lock
// (`evaluateChecklist`, in `packages/core/src/lifecycle/transition.ts`). Each question is answered by
// the item's own record or by the mover; a blocking gap nobody filled stops the move, naming the
// question, and a non-blocking one takes its recommended answer, recorded as assumed (BC-1, BC-24).
// The registered checklists are `checklist-registry.ts:CHECKLISTS`.

import { z } from "zod";
import { fingerprint } from "./fingerprint.js";
import type { Refusal, RefusalStatuses } from "./refusal.js";

export const CHECKLIST_REFUSAL_CODES = [
	"CHECKLIST_INCOMPLETE",
	"CHECKLIST_ANSWER_INVALID",
] as const;
export type ChecklistRefusalCode = (typeof CHECKLIST_REFUSAL_CODES)[number];
export const CHECKLIST_REFUSAL_STATUSES = {
	CHECKLIST_ANSWER_INVALID: 400,
} as const satisfies RefusalStatuses<ChecklistRefusalCode>;

export type ChecklistAnswerType =
	| { readonly kind: "text"; readonly maxLength: number }
	| {
			readonly kind: "choice";
			readonly options: readonly { readonly value: string; readonly label: string }[];
	  };

/** Who answers a question: the item's own record, at a field it already holds, or the mover. */
export type ChecklistAnsweredBy =
	| { readonly by: "record"; readonly field: string }
	| { readonly by: "mover" };

/** A blocking gap stops the move; a non-blocking one takes `recommended`, recorded as assumed. */
export type ChecklistNeed =
	| { readonly blocking: true }
	| { readonly blocking: false; readonly recommended: string };

export interface ChecklistQuestion {
	readonly id: string;
	/** The question, in plain words. */
	readonly prompt: string;
	/** What to do when it is unanswered, in plain words. */
	readonly fix: string;
	readonly answer: ChecklistAnswerType;
	readonly answeredBy: ChecklistAnsweredBy;
	readonly need: ChecklistNeed;
	/** Asked only when an earlier choice question's answer is one of these. */
	readonly when?: { readonly question: string; readonly isOneOf: readonly string[] };
	/** An owner question this reading waits on: it stands as drawn, and is named open. */
	readonly open?: { readonly question: string; readonly note: string };
}

export interface Checklist<Id extends string = string> {
	readonly id: Id;
	readonly title: string;
	/** The moves it gates: the machine entity and the edges into `to`, as the machine declares them. */
	readonly gates: {
		readonly machine: string;
		readonly from: readonly string[];
		readonly to: string;
	};
	/** The approved design step it is built to. */
	readonly design: {
		readonly flow: string;
		readonly revision: number;
		readonly step: string;
	};
	/** The number of shapes it has had, stamped on every move it judges. Never reused. */
	readonly version: number;
	/** The fingerprint of each shape, oldest first; the last is the shape declared now. */
	readonly shapes: readonly string[];
	readonly questions: readonly ChecklistQuestion[];
}

type ChecklistDeclaration<Id extends string> = Omit<Checklist<Id>, "version">;

/** The fingerprint of what a checklist asks: its edge and its questions. */
export function checklistShape(
	checklist: Pick<Checklist, "gates" | "questions">,
): string {
	return fingerprint(JSON.stringify([checklist.gates, checklist.questions]));
}

function declarationFaults(checklist: ChecklistDeclaration<string>): string[] {
	const faults: string[] = [];
	const seen = new Map<string, ChecklistQuestion>();
	for (const q of checklist.questions) {
		if (seen.has(q.id)) faults.push(`question \`${q.id}\` is declared twice`);
		if (q.answer.kind === "choice" && q.answer.options.length === 0) {
			faults.push(`question \`${q.id}\` is a choice with no options`);
		}
		if (!q.need.blocking && answerFault(q, q.need.recommended) !== null) {
			faults.push(`question \`${q.id}\`'s recommended answer is not an answer it takes`);
		}
		if (q.when) {
			const on = seen.get(q.when.question);
			const values =
				on?.answer.kind === "choice" ? on.answer.options.map((o) => o.value) : null;
			if (!values) {
				faults.push(
					`question \`${q.id}\` is asked when \`${q.when.question}\` answers, and that is not an earlier choice question`,
				);
			} else if (q.when.isOneOf.some((v) => !values.includes(v))) {
				faults.push(
					`question \`${q.id}\` is asked on answers \`${q.when.question}\` does not offer`,
				);
			}
		}
		seen.set(q.id, q);
	}
	return faults;
}

/**
 * Declares a checklist, refusing at load a question that repeats, a recommended answer the question
 * does not take, a `when` on no earlier choice, and a shape its `shapes` does not record last: a
 * changed checklist is a new version, and the moves it judged keep the version they were judged by.
 */
export function defineChecklist<const Id extends string>(
	checklist: ChecklistDeclaration<Id>,
): Checklist<Id> {
	const faults = declarationFaults(checklist);
	if (faults.length > 0) {
		throw new Error(`checklist \`${checklist.id}\`: ${faults.join("; ")}`);
	}
	const shape = checklistShape(checklist);
	if (checklist.shapes.at(-1) !== shape) {
		throw new Error(
			`checklist \`${checklist.id}\` asks what no version records: its shape is now ${shape}, and its last recorded shape is ${checklist.shapes.at(-1) ?? "none"}. Append "${shape}" to its \`shapes\` (version ${checklist.shapes.length + 1}).`,
		);
	}
	return { ...checklist, version: checklist.shapes.length };
}

const moverQuestions = (checklist: Checklist) =>
	checklist.questions.filter((q) => q.answeredBy.by === "mover");

function takes(q: ChecklistQuestion): string {
	return q.answer.kind === "text"
		? `text of up to ${q.answer.maxLength} characters`
		: `one of ${q.answer.options.map((o) => `\`${o.value}\``).join(", ")}`;
}

function answerFault(q: ChecklistQuestion, value: unknown): string | null {
	if (typeof value !== "string" || value.trim() === "") return takes(q);
	if (q.answer.kind === "text") {
		return value.trim().length > q.answer.maxLength ? takes(q) : null;
	}
	return q.answer.options.some((o) => o.value === value) ? null : takes(q);
}

function describe(q: ChecklistQuestion): string {
	return q.need.blocking
		? `${q.prompt} Required: ${q.fix}`
		: `${q.prompt} Left unanswered, it is assumed: ${q.need.recommended}`;
}

function valueSchema(q: ChecklistQuestion) {
	if (q.answer.kind === "text") {
		return z.string().trim().min(1).max(q.answer.maxLength).describe(describe(q));
	}
	const [first, ...rest] = q.answer.options.map((o) => o.value);
	return z.enum([first as string, ...rest]).describe(describe(q));
}

/** The answers a move through this checklist may carry: each question the mover answers, none else. */
export function answersSchemaOf(checklist: Checklist) {
	return z.strictObject(
		Object.fromEntries(moverQuestions(checklist).map((q) => [q.id, valueSchema(q).optional()])),
	);
}

/** The answers any of these checklists may carry, for a door that serves every move of one machine. */
export function moveAnswersSchemaOf(checklists: readonly Checklist[]) {
	const [first, ...rest] = checklists.map(answersSchemaOf);
	if (!first) return z.strictObject({});
	if (rest.length === 0) return first;
	const [second, ...more] = rest;
	return z.union([first, second as typeof first, ...more]);
}

/** The JSON Schema an agent sends a move's answers in. */
export function checklistInputOf(checklist: Checklist): Record<string, unknown> {
	const { $schema: _drop, ...schema } = z.toJSONSchema(answersSchemaOf(checklist), {
		io: "input",
	}) as Record<string, unknown>;
	return {
		...schema,
		description: `The answers to the ${checklist.title} checklist (version ${checklist.version}) that the mover gives. The others are read from the item's own record.`,
	};
}

export interface ChecklistFormField {
	readonly name: string;
	/** Where a refusal about this question points: `/answers/<question>`. */
	readonly path: string;
	readonly label: string;
	readonly help: string;
	readonly control: "text" | "choice";
	readonly maxLength: number | null;
	readonly options: readonly { readonly value: string; readonly label: string }[];
	/** `record`: shown, not typed; the item's own field answers it. */
	readonly answeredBy: "record" | "mover";
	readonly recordField: string | null;
	readonly blocking: boolean;
	readonly recommended: string | null;
	readonly when: ChecklistQuestion["when"] | null;
	readonly open: ChecklistQuestion["open"] | null;
}

export interface ChecklistForm {
	readonly checklist: string;
	readonly version: number;
	readonly title: string;
	readonly fields: readonly ChecklistFormField[];
}

/** The fields a person fills, one per question, in the checklist's order. */
export function checklistFormOf(checklist: Checklist): ChecklistForm {
	return {
		checklist: checklist.id,
		version: checklist.version,
		title: checklist.title,
		fields: checklist.questions.map((q) => ({
			name: q.id,
			path: answerPath(q.id),
			label: q.prompt,
			help: q.fix,
			control: q.answer.kind,
			maxLength: q.answer.kind === "text" ? q.answer.maxLength : null,
			options: q.answer.kind === "choice" ? q.answer.options : [],
			answeredBy: q.answeredBy.by,
			recordField: q.answeredBy.by === "record" ? q.answeredBy.field : null,
			blocking: q.need.blocking,
			recommended: q.need.blocking ? null : q.need.recommended,
			when: q.when ?? null,
			open: q.open ?? null,
		})),
	};
}

const answerPath = (question: string) => `/answers/${question}`;

export type ChecklistRefusal = Refusal & {
	code: ChecklistRefusalCode;
	checklist: string;
	version: number;
	question: string | null;
	field: string | null;
};

function invalid(
	checklist: Checklist,
	question: string | null,
	detail: string,
	field: string | null = null,
): ChecklistRefusal {
	return {
		code: "CHECKLIST_ANSWER_INVALID",
		path: question === null ? "/answers" : answerPath(question),
		detail,
		checklist: checklist.id,
		version: checklist.version,
		question,
		field,
	};
}

export type ParsedAnswers =
	| { readonly ok: true; readonly answers: Readonly<Record<string, string>> }
	| { readonly ok: false; readonly refusals: ChecklistRefusal[] };

/**
 * The mover's answers, refused by name where they are not answers this checklist takes: not an
 * object, a question it does not ask, a question the record answers, or a value of the wrong kind.
 * Nothing is dropped or coerced; an empty answer is not an answer.
 */
export function parseAnswers(checklist: Checklist, raw: unknown): ParsedAnswers {
	if (raw === undefined || raw === null) return { ok: true, answers: {} };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		return {
			ok: false,
			refusals: [
				invalid(
					checklist,
					null,
					`The answers to the ${checklist.title} checklist are an object of question ids to answers.`,
				),
			],
		};
	}
	const byId = new Map(checklist.questions.map((q) => [q.id, q]));
	const asked = moverQuestions(checklist).map((q) => `\`${q.id}\``);
	const refusals: ChecklistRefusal[] = [];
	const answers: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		const q = byId.get(key);
		if (!q) {
			refusals.push(
				invalid(
					checklist,
					key,
					`\`${key}\` is not a question of the ${checklist.title} checklist. The questions answered in the move are ${asked.join(", ") || "none"}.`,
				),
			);
			continue;
		}
		if (q.answeredBy.by === "record") {
			refusals.push(
				invalid(
					checklist,
					key,
					`"${q.prompt}" is answered by the item's own ${q.answeredBy.field}, not in the move. ${q.fix}`,
					q.answeredBy.field,
				),
			);
			continue;
		}
		const fault = answerFault(q, value);
		if (fault) {
			refusals.push(invalid(checklist, key, `"${q.prompt}" takes ${fault}.`));
			continue;
		}
		answers[key] = (value as string).trim();
	}
	return refusals.length > 0 ? { ok: false, refusals } : { ok: true, answers };
}

/** What the item's own record answers to a record question, or why it cannot. */
export type RecordAnswer =
	| { readonly value: string }
	| { readonly gap: string };

export type RecordAnswers = Readonly<Record<string, RecordAnswer>>;

export const CHECKLIST_PROVENANCES = ["given", "assumed"] as const;
export type ChecklistProvenance = (typeof CHECKLIST_PROVENANCES)[number];

export interface ChecklistAnswer {
	readonly question: string;
	readonly value: string;
	readonly provenance: ChecklistProvenance;
	/** `mover`, `record:<field>`, or `recommended` for an assumed answer. */
	readonly source: string;
	/** The owner question an assumed answer's reading still waits on. */
	readonly open?: string;
}

export interface ChecklistGap {
	readonly question: string;
	readonly path: string;
	readonly detail: string;
	readonly field: string | null;
}

export interface ChecklistEvaluation {
	readonly checklist: string;
	readonly version: number;
	readonly complete: boolean;
	readonly answers: readonly ChecklistAnswer[];
	readonly gaps: readonly ChecklistGap[];
	/** Questions not asked, their `when` unmet. */
	readonly notAsked: readonly string[];
}

/**
 * Reads every question in order: a given answer stands; a record question takes what the record
 * holds; a gap on a non-blocking question takes its recommended answer, recorded as assumed; a gap
 * on a blocking one is named. A record question the reader did not answer is a defect of the
 * reader, not a gap, and throws.
 */
export function evaluateChecklist(
	checklist: Checklist,
	input: {
		readonly given: Readonly<Record<string, string>>;
		readonly record: RecordAnswers;
	},
): ChecklistEvaluation {
	const answers: ChecklistAnswer[] = [];
	const gaps: ChecklistGap[] = [];
	const notAsked: string[] = [];
	const valueOf = new Map<string, string>();
	for (const q of checklist.questions) {
		if (q.when && !q.when.isOneOf.includes(valueOf.get(q.when.question) ?? "")) {
			notAsked.push(q.id);
			continue;
		}
		const field = q.answeredBy.by === "record" ? q.answeredBy.field : null;
		let found: { value: string; source: string } | { gap: string };
		if (q.answeredBy.by === "record") {
			const held = input.record[q.id];
			if (!held) {
				throw new Error(
					`checklist \`${checklist.id}\`: the record reader answered nothing for \`${q.id}\``,
				);
			}
			found = "value" in held ? { value: held.value, source: `record:${q.answeredBy.field}` } : held;
		} else {
			const given = input.given[q.id];
			found = given !== undefined ? { value: given, source: "mover" } : { gap: "" };
		}
		if ("value" in found) {
			answers.push({ question: q.id, value: found.value, provenance: "given", source: found.source });
			valueOf.set(q.id, found.value);
			continue;
		}
		if (!q.need.blocking) {
			answers.push({
				question: q.id,
				value: q.need.recommended,
				provenance: "assumed",
				source: "recommended",
				...(q.open ? { open: q.open.question } : {}),
			});
			valueOf.set(q.id, q.need.recommended);
			continue;
		}
		gaps.push({
			question: q.id,
			path: answerPath(q.id),
			detail: [q.prompt, found.gap, q.fix].filter((s) => s !== "").join(" "),
			field,
		});
	}
	return {
		checklist: checklist.id,
		version: checklist.version,
		complete: gaps.length === 0,
		answers,
		gaps,
		notAsked,
	};
}

/** One refusal per blocking gap, each on its question's path and in plain words. */
export function checklistRefusals(evaluation: ChecklistEvaluation): ChecklistRefusal[] {
	return evaluation.gaps.map((gap) => ({
		code: "CHECKLIST_INCOMPLETE",
		path: gap.path,
		detail: gap.detail,
		checklist: evaluation.checklist,
		version: evaluation.version,
		question: gap.question,
		field: gap.field,
	}));
}

/**
 * How a gated move stands: passed its checklist, refused, or recorded before its edge had one. Only
 * `passed` counts as passing (BC-9).
 */
export const GATED_MOVE_STANDINGS = ["passed", "refused", "no_checklist"] as const;
export type GatedMoveStanding = (typeof GATED_MOVE_STANDINGS)[number];

export function gatedMoveStanding(move: {
	readonly refused: boolean;
	readonly checklistVersion: number | null;
}): GatedMoveStanding {
	if (move.refused) return "refused";
	return move.checklistVersion === null ? "no_checklist" : "passed";
}

export const countsAsPassed = (standing: GatedMoveStanding): boolean => standing === "passed";
