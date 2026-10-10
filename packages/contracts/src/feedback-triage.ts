// The triage checklist as a triage act carries it (Feedback lifecycle r14 triage-check; Feedback
// triage r16 check and decide). The triager's answers ride `answers`, keyed by question; the route is
// the act's own `route`, since a decline is an act and not a route. The short form (BC-6): a bug that
// names the criterion it violates needs only that criterion, the reproduction and the severity, and
// takes the issue route on the criterion's requirement.

import { z } from "zod";
import { FEEDBACK_TRIAGE_CHECKLIST, NO_CRITERION } from "./checklist-registry.js";
import { answersSchemaOf, type DerivedAnswer } from "./checklists.js";
import type { FeedbackKind, FeedbackRoute } from "./feedback-terms.js";

/** The one question a triage answers outside `answers`: its `route`. */
export const TRIAGE_ROUTE_QUESTION = "route";

/** A triage's `answers` as the checklist derives them: each question the triager answers, the route left to `route`. */
export const triageAnswersSchema = answersSchemaOf(FEEDBACK_TRIAGE_CHECKLIST).omit({
	[TRIAGE_ROUTE_QUESTION]: true,
});
export type TriageAnswers = z.infer<typeof triageAnswersSchema>;

/** The JSON Schema of a triage's `answers`. */
export function triageAnswersInput(): Record<string, unknown> {
	const { $schema: _drop, ...input } = z.toJSONSchema(triageAnswersSchema, { io: "input" }) as Record<
		string,
		unknown
	>;
	return {
		...input,
		description: `The answers to the ${FEEDBACK_TRIAGE_CHECKLIST.title} checklist (version ${FEEDBACK_TRIAGE_CHECKLIST.version}) the triager gives, by question. The route is sent as \`route\`. A bug naming the criterion it violates needs only criterion, reproduced and severity.`,
	};
}

const CRITERION_REF = /^(REQ-[1-9]\d{0,8}) (BC-[1-9]\d{0,4})$/;

export type CriterionAnswer =
	| { readonly none: true }
	| { readonly none: false; readonly requirement: string; readonly code: string };

/** A criterion answer read: "none", or a `REQ-n BC-m` reference; null when it is neither. */
export function criterionAnswerOf(answer: string): CriterionAnswer | null {
	const text = answer.trim();
	if (text === NO_CRITERION) return { none: true };
	const m = CRITERION_REF.exec(text);
	return m ? { none: false, requirement: m[1] as string, code: m[2] as string } : null;
}

const objectOf = (answers: unknown): Record<string, unknown> | null =>
	typeof answers === "object" && answers !== null && !Array.isArray(answers)
		? (answers as Record<string, unknown>)
		: null;

/** The criterion the answers name, or null where they name none or none readable. */
export function namedCriterionOf(answers: unknown): { requirement: string; code: string } | null {
	const given = objectOf(answers)?.criterion;
	if (typeof given !== "string") return null;
	const read = criterionAnswerOf(given);
	return read && !read.none ? read : null;
}

/** Whether a triage takes the short form: a bug naming the criterion it violates (BC-6). */
export const isShortForm = (kind: FeedbackKind, answers: unknown): boolean =>
	kind === "bug" && namedCriterionOf(answers) !== null;

/** The routes a bug against a named criterion may take: an issue on it, or the duplicate it is. */
export const SHORT_FORM_ROUTES: readonly FeedbackRoute[] = ["issue", "duplicate"];

/** The route a triage takes: the one it sent, else the issue route the short form gives, else none. */
export function triageRouteOf(input: {
	kind: FeedbackKind;
	route: FeedbackRoute | undefined;
	answers: unknown;
}): FeedbackRoute | undefined {
	if (input.route !== undefined) return input.route;
	return isShortForm(input.kind, input.answers) ? "issue" : undefined;
}

/** The rule a short-form triage's route is recorded as derived by. */
export const SHORT_FORM_RULE = "short-form";

/**
 * The answers a triage hands the checklist: the triager's own with the route it sent. Answers that
 * are not an object are handed on as sent, so the check refuses them by name.
 */
export function triageAnswersOf(input: {
	route: FeedbackRoute | undefined;
	answers: unknown;
}): unknown {
	const given = input.answers === undefined ? {} : objectOf(input.answers);
	if (given === null) return input.answers;
	return input.route === undefined ? given : { ...given, [TRIAGE_ROUTE_QUESTION]: input.route };
}

/**
 * What the checklist takes from a rule rather than from the triager: the issue route the short form
 * gives a bug naming its criterion when no route was sent, recorded as derived by that rule.
 */
export function triageDerivedOf(input: {
	kind: FeedbackKind;
	route: FeedbackRoute | undefined;
	answers: unknown;
}): Record<string, DerivedAnswer> {
	if (input.route !== undefined || !isShortForm(input.kind, input.answers)) return {};
	return { [TRIAGE_ROUTE_QUESTION]: { value: "issue", rule: SHORT_FORM_RULE } };
}
