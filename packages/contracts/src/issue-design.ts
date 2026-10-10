// One declaration of an issue's design record (REQ-36 BC-1, BC-2, BC-13; Issue lifecycle r15
// `design-check`, Issue to release r20 `issue` and `criteria`): per criterion its class, its
// catalogued pattern and its proof plan, and the modules and contracts the change touches. Core's
// table CHECKs, the REST door and the design check import from here.

import { z } from "zod";
import { PATTERN_SLUG_PATTERN } from "./patterns.js";
import { PERMISSION_REFUSAL_CODES } from "./permissions.js";

/**
 * `observable`: judged on the running build. `code_property`: a property of the code no running
 * build shows, judged by the review against the diff.
 */
export const CRITERION_CLASSES = ["observable", "code_property"] as const;
export type CriterionClass = (typeof CRITERION_CLASSES)[number];

/** Who judges a criterion: QA on the running build, or the review against the diff. */
export const CRITERION_JUDGES = ["qa", "review"] as const;
export type CriterionJudge = (typeof CRITERION_JUDGES)[number];

/** The judge each class is routed to (BC-13). */
export const JUDGE_OF_CLASS: Record<CriterionClass, CriterionJudge> = {
	observable: "qa",
	code_property: "review",
};

export const DESIGN_LIMITS = {
	proof: 2000,
	modules: 50,
	contracts: 50,
	criteria: 50,
} as const;

/** No design is recorded on the issue. */
export const DESIGN_RECORD_MISSING = "DESIGN_RECORD_MISSING" as const;
/** A design is recorded and a part the check asks is missing or no longer holds. */
export const DESIGN_RECORD_INCOMPLETE = "DESIGN_RECORD_INCOMPLETE" as const;

/** What the design check refuses a move into build with, at every door. */
export const DESIGN_CHECK_CODES = [DESIGN_RECORD_MISSING, DESIGN_RECORD_INCOMPLETE] as const;
export type DesignCheckCode = (typeof DESIGN_CHECK_CODES)[number];

export const ISSUE_DESIGN_REFUSAL_CODES = [
	"DESIGN_REFUSED",
	"DESIGN_CRITERION_UNKNOWN",
	"DESIGN_CRITERION_REPEATED",
	"DESIGN_CRITERION_LEFT_OUT",
	"DESIGN_PATTERN_REQUIRED",
	"DESIGN_PATTERN_UNCATALOGUED",
	"DESIGN_PATTERN_UNDECLARED",
	"DESIGN_MODULE_UNKNOWN",
	"DESIGN_CONTRACT_UNKNOWN",
	"DESIGN_ISSUE_FINISHED",
	...PERMISSION_REFUSAL_CODES,
] as const;
export type IssueDesignRefusalCode = (typeof ISSUE_DESIGN_REFUSAL_CODES)[number];

/** Every design refusal is a rule the write broke (422). */
export const ISSUE_DESIGN_REFUSAL_STATUSES = {} as const satisfies Partial<
	Record<IssueDesignRefusalCode, 409>
>;

export interface IssueDesignRefusal {
	code: IssueDesignRefusalCode;
	path: string;
	detail: string;
}

/** A verdict on a criterion its class routes to the other judge. */
export const VERDICT_JUDGE_REFUSAL_CODES = [
	"VERDICT_JUDGED_BY_REVIEW",
	"VERDICT_JUDGED_BY_QA",
] as const;

const criterionDesignSchema = z.strictObject({
	/** The criterion's number on the issue (`1. …`). */
	criterion: z.number().int().min(1),
	class: z.enum(CRITERION_CLASSES),
	/** A catalog slug, or a new pattern approved on the issue; null only where the project reads no catalog. */
	pattern: z.string().trim().regex(PATTERN_SLUG_PATTERN).nullable(),
	/** How it will be proven: the probe for an observable criterion, the review line for a code property. */
	proof: z.string().trim().min(1).max(DESIGN_LIMITS.proof),
});

export const recordDesignRequestSchema = z.strictObject({
	criteria: z.array(criterionDesignSchema).min(1).max(DESIGN_LIMITS.criteria),
	/** Module names (or label ids) of the project the change touches; at least one. */
	modules: z.array(z.string().trim().min(1).max(200)).min(1).max(DESIGN_LIMITS.modules),
	/** `<project>/<contract>` the change touches; empty where it touches none. */
	contracts: z.array(z.string().trim().min(1).max(200)).max(DESIGN_LIMITS.contracts),
});
export type RecordDesignRequest = z.infer<typeof recordDesignRequestSchema>;
export const RECORD_DESIGN_SHAPE =
	"{ criteria: [{ criterion: the criterion's number, class: 'observable' | 'code_property', pattern: a catalog slug or a new pattern approved on this issue (null only where the project reads no catalog), proof: the probe or the review line that will prove it }], one per live criterion; modules: the module names the change touches, at least one; contracts: the `<project>/<contract>` it touches, [] for none }";

export interface CriterionDesignView {
	criterion: number;
	statement: string;
	class: CriterionClass;
	judge: CriterionJudge;
	pattern: string | null;
	proof: string;
}

export interface IssueDesignView {
	issue: string;
	revision: number;
	criteria: CriterionDesignView[];
	modules: { id: string; name: string }[];
	contracts: string[];
	recordedBy: string;
	recordedAt: string;
}

/**
 * One part the design check found missing, as a fact a client words for itself: no record at all,
 * an issue with no criteria, a criterion with no line (or one whose pattern no longer holds), or
 * the modules (none named, or one no longer a module of the project).
 */
export type DesignGap =
	| { part: "design" }
	| { part: "criteria" }
	| { part: "criterion"; criterion: number }
	| { part: "modules" };

/** The design check as the issue stands now: passed, or the refusal a move into build gets. */
export type DesignCheck =
	| { passed: true }
	| { passed: false; code: DesignCheckCode; missing: string[]; gaps: DesignGap[]; detail: string };

export interface IssueDesign {
	/** Whether the project reads a pattern catalog, so whether each criterion names a pattern. */
	catalogDeclared: boolean;
	design: IssueDesignView | null;
	check: DesignCheck;
}
