// An issue's review (REQ-36 BC-8; Issue to release r20 `rule-merge`, `criteria`): the diff between
// two commits checked against the checklist of each pattern the issue's design chose and against the
// evidence already recorded, one result per checklist line and per code-property criterion. A
// review reruns nothing: its request carries no check, test or probe, and its record cites what was
// recorded at the head it reviewed. `POST /api/issues/:id/review` records one; the merge mark of an
// issue the merge check is owed for is refused `MERGE_REVIEW_MISSING` until a passing review by a
// reviewer other than the building run stands at the commit it marks.

import { z } from "zod";
import { wholeShaSchema } from "./check-runs.js";
import { PATTERN_SLUG_PATTERN } from "./patterns.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";

/** A checklist line held, broken, or not reached by this diff. */
export const REVIEW_LINE_RESULTS = ["pass", "fail", "not_applicable"] as const;
export type ReviewLineResult = (typeof REVIEW_LINE_RESULTS)[number];

/** A code-property criterion held or broken by this diff. */
export const REVIEW_CRITERION_RESULTS = ["pass", "fail"] as const;
export type ReviewCriterionResult = (typeof REVIEW_CRITERION_RESULTS)[number];

export const REVIEW_LIMITS = {
	note: 400,
	lines: 200,
	criteria: 50,
	evidence: 10,
	citation: 400,
} as const;

const note = z
	.string()
	.trim()
	.min(1, "say what in the diff or the evidence the line was checked against")
	.max(REVIEW_LIMITS.note);

export const reviewChecklistResultSchema = z.strictObject({
	/** The catalog slug of a pattern the issue's design chose. */
	pattern: z
		.string()
		.trim()
		.regex(PATTERN_SLUG_PATTERN, "pattern is a catalog slug"),
	/** The checklist line's number on that pattern's page, from 1. */
	line: z.number().int().min(1),
	result: z.enum(REVIEW_LINE_RESULTS),
	note,
});
export type ReviewChecklistEntry = z.infer<typeof reviewChecklistResultSchema>;

export const reviewCriterionResultSchema = z.strictObject({
	criterion: z.number().int().min(1),
	result: z.enum(REVIEW_CRITERION_RESULTS),
	reason: note,
	/** What it was judged from: a path inside the repository at `head`, a URL or an attachment name. */
	evidence: z
		.array(z.string().trim().min(1).max(REVIEW_LIMITS.citation))
		.min(1, "a criterion's result cites what it was judged from")
		.max(REVIEW_LIMITS.evidence),
});
export type ReviewCriterionEntry = z.infer<typeof reviewCriterionResultSchema>;

/**
 * A review as a reviewer sends it. Strict: a key for a check, a test or a probe result is refused as
 * unknown, because a review runs none of them and cites the ones recorded at `head` instead.
 */
export const recordReviewRequestSchema = z.strictObject({
	/** The diff reviewed is `base..head`. */
	base: wholeShaSchema("base"),
	head: wholeShaSchema("head"),
	/** When the review began: its time is counted with the issue's checks (REQ-36 BC-14). */
	startedAt: z.iso.datetime({
		offset: true,
		error: "startedAt is when the review began, an ISO 8601 date-time",
	}),
	checklist: z.array(reviewChecklistResultSchema).max(REVIEW_LIMITS.lines),
	criteria: z.array(reviewCriterionResultSchema).max(REVIEW_LIMITS.criteria),
	/** The run making the call, where the box's runs share one credential. */
	run: z.string().trim().min(1).max(200).optional(),
});
export type RecordReviewRequest = z.infer<typeof recordReviewRequestSchema>;

export const RECORD_REVIEW_SHAPE =
	"{ base: <40 hex>, head: <40 hex>, startedAt: <ISO 8601>, checklist: [{ pattern, line, result: pass | fail | not_applicable, note }], criteria: [{ criterion, result: pass | fail, reason, evidence: [..] }], run? }";

/** A merge mark where a review is owed and no passing one by another than the builder stands at the commit. */
export const MERGE_REVIEW_MISSING = "MERGE_REVIEW_MISSING" as const;

export const ISSUE_REVIEW_REFUSAL_CODES = [
	"REVIEW_REFUSED",
	"REVIEW_DESIGN_MISSING",
	"REVIEW_LINE_MISSING",
	"REVIEW_LINE_UNKNOWN",
	"REVIEW_LINE_REPEATED",
	"REVIEW_NOTE_REQUIRED",
	"REVIEW_BY_BUILDER",
	"REVIEW_RUN_UNNAMED",
	"REVIEW_RUN_UNKNOWN",
	"REVIEW_ISSUE_FINISHED",
	...PERMISSION_REFUSAL_CODES,
] as const;
export type IssueReviewRefusalCode =
	(typeof ISSUE_REVIEW_REFUSAL_CODES)[number];

/** The record's `result`: pass where every line and criterion holds, else fail. */
export const REVIEW_OUTCOMES = ["pass", "fail"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** A checklist line a review owes. */
export interface OwedChecklistLine {
	pattern: string;
	line: number;
	text: string;
}

/** A code-property criterion a review owes. */
export interface OwedCriterion {
	criterion: number;
	statement: string;
}

/** What a review of this issue owes, read from its design record and the catalog of this build. */
export interface ReviewOwed {
	checklist: OwedChecklistLine[];
	criteria: OwedCriterion[];
	/** Chosen patterns this build's catalog holds no page for: no checklist line is owed for them. */
	unread: string[];
	/** Null where the project reads a catalog; else why no checklist line is owed at all. */
	noCatalog: string | null;
}

/** One recorded review, as the read lists it. */
export interface ReviewView {
	id: string;
	base: string;
	head: string;
	result: ReviewOutcome;
	failed: string[];
	reviewer: { session: string | null; box: string | null; user: string | null };
	recordedAt: string;
}

/** `GET /api/issues/:id/review`: what a review owes, whether the mark asks one, and the reviews recorded. */
export interface IssueReview {
	issue: string;
	/** Whether the merge mark asks a review of this issue (`validation.mergeCheck: required`). */
	required: boolean;
	owed: ReviewOwed | null;
	/** Null where the design passes; else why no review can be recorded yet. */
	refusal: { code: string; detail: string } | null;
	reviews: ReviewView[];
}
