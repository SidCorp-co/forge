// One declaration of the pattern vocabulary (REQ-36 BC-2, BC-3, BC-4; Issue lifecycle r14
// `design-check`): the patterns an issue names, the new-pattern review, and the catalog entry shape.
// Core's table CHECKs, the REST doors and the generated catalog import from here.

import { z } from "zod";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";

/** A pattern's slug: its catalog page's file name, and what an issue names. */
export const PATTERN_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Where a repository's catalog pages live, one `<slug>.md` each. */
export const PATTERN_CATALOG_DIR = "docs/patterns";

export const PATTERN_LIMITS = { summary: 2000, reason: 2000 } as const;

/** One catalog entry, as `scripts/check-pattern-catalog.mjs --write` reads it from its page. */
export interface PatternEntry {
	slug: string;
	title: string;
	changeKind: string;
	/** The page, from the repository root. */
	page: string;
	/** The issue whose change landed the entry. */
	introducedBy: string;
	/** The files a new change copies. */
	reference: readonly string[];
	/** The reference tests a new change's tests are shaped like. */
	tests: readonly string[];
	/** The lines a review checks the diff against, in order. */
	checklist: readonly string[];
}

/** `reuse`: the pattern is in the catalog and needs no approval. `new`: it is not, and one reviewer decides it. */
export const ISSUE_PATTERN_KINDS = ["reuse", "new"] as const;
export type IssuePatternKind = (typeof ISSUE_PATTERN_KINDS)[number];

/** A new pattern's one decision. */
export const PATTERN_DECISIONS = ["approved", "returned"] as const;
export type PatternDecision = (typeof PATTERN_DECISIONS)[number];

/** A dispatch door refuses, and the admissible list withholds, an issue whose new pattern waits on its reviewer. */
export const PATTERN_REVIEW_PENDING = "PATTERN_REVIEW_PENDING" as const;

/**
 * The merge mark refuses an approved new pattern whose catalog page is not in the change it reads
 * (Issue to release r20 `rule-merge`, which ISS-472's merge check takes over before the merge).
 */
export const PATTERN_ENTRY_MISSING = "PATTERN_ENTRY_MISSING" as const;

/**
 * A returned new pattern no later pattern of the issue answers: the work step cannot move to build
 * and the issue cannot move to awaiting_release until the issue names another pattern or names the
 * slug again revised (Issue lifecycle r14 `design-check`). The issue stays dispatchable, because a
 * run has to take it to answer.
 */
export const PATTERN_RETURNED = "PATTERN_RETURNED" as const;

export const PATTERN_REFUSAL_CODES = [
	"PATTERN_REFUSED",
	"PATTERN_CATALOG_UNDECLARED",
	"PATTERN_ALREADY_NAMED",
	"PATTERN_ISSUE_FINISHED",
	"PATTERN_NOT_NEW",
	"PATTERN_ALREADY_DECIDED",
	"PATTERN_RETRACTED",
	"PATTERN_REVIEWER_IS_AUTHOR",
	"PATTERN_SUMMARY_REQUIRED",
	"PATTERN_RUN_UNKNOWN",
	"PATTERN_RUN_UNNAMED",
	"PATTERN_REVIEWER_RUN_UNNAMED",
	PATTERN_REVIEW_PENDING,
	PATTERN_ENTRY_MISSING,
	PATTERN_RETURNED,
	...PERMISSION_REFUSAL_CODES,
] as const;
export type PatternRefusalCode = (typeof PATTERN_REFUSAL_CODES)[number];

/** A decision raced by another reviewer is a lost compare-and-set (409); every other pattern refusal is a rule (422). */
export const PATTERN_REFUSAL_STATUSES = {
	PATTERN_ALREADY_DECIDED: 409,
} as const satisfies Partial<Record<PatternRefusalCode, 409>>;

export interface PatternRefusal {
	code: PatternRefusalCode;
	path: string;
	detail: string;
}

/**
 * The run a box's call is made from: the run id the box declared (`POST /api/devices/me/run-sessions`
 * `runId`) or core's id for that run. A box's runs share its credential, so a call that does not hold
 * the issue's lease says which run it is; a person's call names none.
 */
const runField = z.uuid();

export const namePatternRequestSchema = z.strictObject({
	pattern: z.string().trim().regex(PATTERN_SLUG_PATTERN),
	/** What the new pattern is and why no catalogued one serves; required where the pattern is not catalogued. */
	summary: z.string().trim().min(1).max(PATTERN_LIMITS.summary).optional(),
	/** The run naming it, where the box making the call holds no lease on the issue. */
	run: runField.optional(),
});
export type NamePatternRequest = z.infer<typeof namePatternRequestSchema>;
export const NAME_PATTERN_SHAPE =
	"{ pattern: the slug of a catalog entry (docs/patterns/<slug>.md), or of the new pattern this issue introduces; summary?: what a new pattern is and why no catalogued one serves, required for a new one; run?: on a box credential that holds no lease on the issue, the run id the box declared }";

export const decidePatternRequestSchema = z.strictObject({
	decision: z.enum(PATTERN_DECISIONS),
	reason: z.string().trim().min(1).max(PATTERN_LIMITS.reason),
	/** The run deciding it, on a box credential; never the run that named it. */
	run: runField.optional(),
});
export type DecidePatternRequest = z.infer<typeof decidePatternRequestSchema>;
export const DECIDE_PATTERN_SHAPE =
	"{ decision: 'approved' | 'returned'; reason: why, which a returned pattern's author reads and which is posted on the issue when it is returned; run?: on a box credential, the run id the box declared for the run deciding }";

export const retractPatternRequestSchema = z.strictObject({
	reason: z.string().trim().min(1).max(PATTERN_LIMITS.reason),
});
export type RetractPatternRequest = z.infer<typeof retractPatternRequestSchema>;
export const RETRACT_PATTERN_SHAPE =
	"{ reason } says why the issue no longer takes this pattern";

export interface IssuePatternView {
	id: string;
	issue: string;
	pattern: string;
	kind: IssuePatternKind;
	summary: string | null;
	namedBy: string;
	/** The run session that named it; null where a person named it. */
	namedSession: string | null;
	namedAt: string;
	/** The new pattern's decision; always null for a reuse, which nobody decides. */
	decision: PatternDecision | null;
	decidedBy: string | null;
	/** The run session that decided it; null where a person did, or nobody yet. */
	decidedSession: string | null;
	decidedAt: string | null;
	decisionReason: string | null;
	retractedAt: string | null;
	retractReason: string | null;
	/** Whether this row holds its issue: a new pattern, undecided, not retracted. */
	pending: boolean;
	/** A returned row no later live row of the issue answers: it holds the work out of build. */
	unanswered: boolean;
}

/** Whether the project reads a pattern catalog; where it does not, a run names no pattern. */
export interface PatternCatalogStanding {
	declared: boolean;
	/** Why it reads none, in the words naming one would be refused with; null where it reads one. */
	detail: string | null;
}

export interface IssuePatterns {
	catalog: PatternCatalogStanding;
	patterns: IssuePatternView[];
	/** False while a new pattern waits on its reviewer. */
	dispatchable: boolean;
	refusal: { code: typeof PATTERN_REVIEW_PENDING; detail: string } | null;
	/** An unanswered return: the work step cannot move to build, nor the issue to awaiting_release. */
	returned: { code: typeof PATTERN_RETURNED; detail: string } | null;
	/** The pending patterns the caller may decide now: holding patterns.approve, and not their author. */
	decidable: string[];
}

export interface IssuePatternResponse {
	pattern: IssuePatternView;
}
