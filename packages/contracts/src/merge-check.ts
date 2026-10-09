// The merge check's record (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17; ISS-472):
// the report a project's merge check writes (`scripts/merge-check.mjs` in this repository), which
// `POST /api/issues/:id/merge-check` records on the issue and the merge mark then asks for.

import { z } from "zod";
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

/** `none`: the selection held nothing to run, which the check says rather than skipping silently. */
export const MERGE_CHECK_RESULTS = ["pass", "fail", "none"] as const;
export type MergeCheckResult = (typeof MERGE_CHECK_RESULTS)[number];

/** `pre-merge`: the change rebased on the latest base, before it lands. `landed`: already on it. */
export const MERGE_CHECK_MODES = ["pre-merge", "landed"] as const;
export type MergeCheckMode = (typeof MERGE_CHECK_MODES)[number];

const sha = (what: string) =>
	z
		.string()
		.trim()
		.regex(/^[0-9a-f]{40}$/i, `${what} is a whole git sha: 40 hex characters`);

const LIMITS = { checks: 200, files: 2000, touched: 2000, text: 500 } as const;

export const mergeCheckRunSchema = z.strictObject({
	name: z.string().trim().min(1).max(64),
	scope: z.string().trim().max(120),
	command: z.string().max(LIMITS.text),
	files: z.array(z.string().min(1).max(1000)).max(LIMITS.files),
	result: z.enum(MERGE_CHECK_RESULTS),
	durationMs: z.number().int().nonnegative(),
	note: z.string().max(LIMITS.text).optional(),
});
export type MergeCheckRun = z.infer<typeof mergeCheckRunSchema>;

export const mergeCheckReportSchema = z.strictObject({
	base: z.strictObject({
		branch: z.string().trim().min(1).max(200),
		sha: sha("base.sha"),
	}),
	head: sha("head"),
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
	checks: z.array(mergeCheckRunSchema).min(1).max(LIMITS.checks),
});
export type MergeCheckReport = z.infer<typeof mergeCheckReportSchema>;

export const MERGE_CHECK_SHAPE =
	"{ base: { branch, sha }, head, mode: pre-merge | landed, touched: [{ path, change }], checks: [{ name, scope, command, files, result: pass | fail | none, durationMs, note? }] }";

/** A mark where a merge check is owed and none passed at the commit marked. */
export const MERGE_CHECK_MISSING = "MERGE_CHECK_MISSING" as const;

export const MERGE_CHECK_REFUSAL_CODES = [
	"MERGE_CHECK_REFUSED",
	"MERGE_CHECK_RED",
	"MERGE_BEHIND_BASE",
	"MERGE_CHECK_INCOMPLETE",
	PATTERN_ENTRY_MISSING,
] as const;
export type MergeCheckRefusalCode = (typeof MERGE_CHECK_REFUSAL_CODES)[number];

/** The `verification` record a passing check is kept as: its `check` field reads this. */
export const MERGE_CHECK_RECORD = "merge";
