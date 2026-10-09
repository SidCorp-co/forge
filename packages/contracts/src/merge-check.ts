// The merge check's record (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17; ISS-472):
// the report a project's merge check writes (`scripts/merge-check.mjs` in this repository), which
// `POST /api/issues/:id/merge-check` records on the issue and the merge mark then asks for.

import { z } from "zod";
import {
	CHECK_RUN_SHAPE,
	type CheckKind,
	checkRunsSchema,
	wholeShaSchema,
} from "./check-runs.js";
import { ARTIFACT_CHANGES } from "./landing-artifacts.js";
import { PATTERN_ENTRY_MISSING } from "./patterns.js";

/** Every check a merge needs, by name. Kept probes (ISS-469) and the review (ISS-473) join here. */
export const REQUIRED_MERGE_CHECKS = [
	"rebased-on-base",
	"typecheck",
	"direct-tests",
	"integration-tests",
	"verify",
] as const;
export type RequiredMergeCheck = (typeof REQUIRED_MERGE_CHECKS)[number];

/** The kind each required check is, so its time is counted where the issue page shows it. */
export const MERGE_CHECK_KINDS = {
	"rebased-on-base": "base",
	typecheck: "typecheck",
	"direct-tests": "tests",
	"integration-tests": "tests",
	verify: "conformance",
} as const satisfies Record<RequiredMergeCheck, CheckKind>;

/** `pre-merge`: the change rebased on the latest base, before it lands. `landed`: already on it. */
export const MERGE_CHECK_MODES = ["pre-merge", "landed"] as const;
export type MergeCheckMode = (typeof MERGE_CHECK_MODES)[number];

const LIMITS = { checks: 200, touched: 2000 } as const;

export const mergeCheckReportSchema = z.strictObject({
	base: z.strictObject({
		branch: z.string().trim().min(1).max(200),
		sha: wholeShaSchema("base.sha"),
	}),
	head: wholeShaSchema("head"),
	mode: z.enum(MERGE_CHECK_MODES),
	touched: z
		.array(
			z.strictObject({
				path: z.string().min(1).max(1000),
				change: z.enum(ARTIFACT_CHANGES),
			}),
		)
		.min(1, "touched names at least one file: a change that touches nothing has nothing to merge")
		.max(LIMITS.touched),
	/** Each one a check run (`./check-runs.ts`): recorded once, with its kind and duration. */
	checks: checkRunsSchema(LIMITS.checks),
});
export type MergeCheckReport = z.infer<typeof mergeCheckReportSchema>;

export const MERGE_CHECK_SHAPE = `{ base: { branch, sha }, head, mode: pre-merge | landed, touched: [{ path, change }], checks: [${CHECK_RUN_SHAPE}] }`;

/** A mark where a merge check is owed and none passed at the commit marked. */
export const MERGE_CHECK_MISSING = "MERGE_CHECK_MISSING" as const;

export const MERGE_CHECK_REFUSAL_CODES = [
	"MERGE_CHECK_REFUSED",
	"MERGE_CHECK_RED",
	"MERGE_BEHIND_BASE",
	"MERGE_CHECK_INCOMPLETE",
	"MERGE_CHECK_KIND_MISMATCH",
	PATTERN_ENTRY_MISSING,
] as const;
export type MergeCheckRefusalCode = (typeof MERGE_CHECK_REFUSAL_CODES)[number];

/** The `verification` record a passing check is kept as: its `check` field reads this. */
export const MERGE_CHECK_RECORD = "merge";
