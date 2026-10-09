// The merge check's record (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17; ISS-472):
// the report a project's merge check writes (`scripts/merge-check.mjs` in this repository), which
// `POST /api/issues/:id/merge-check` records on the issue and the merge mark then asks for. A report
// on the fast lane (REQ-39 BC-7, `./fast-lane.ts`) needs only `FAST_LANE_MERGE_CHECKS` and names the
// patch id of what it checked, which core holds to the patch id the approved preview served.

import { z } from "zod";
import {
	CHECK_RUN_SHAPE,
	type CheckKind,
	checkRunsSchema,
	wholeShaSchema,
} from "./check-runs.js";
import { FAST_LANE_MERGE_CHECKS, LANES, type Lane } from "./fast-lane.js";
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

/** The checks a report on `lane` needs: the fast lane's three, else every one a merge needs. */
export function requiredMergeChecksOf(
	lane: Lane | undefined,
): readonly RequiredMergeCheck[] {
	return lane === "fast" ? FAST_LANE_MERGE_CHECKS : REQUIRED_MERGE_CHECKS;
}

export const mergeCheckReportSchema = z
	.strictObject({
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
			.min(
				1,
				"touched names at least one file: a change that touches nothing has nothing to merge",
			)
			.max(LIMITS.touched),
		/** Each one a check run (`./check-runs.ts`): recorded once, with its kind and duration. */
		checks: checkRunsSchema(LIMITS.checks),
		/** The lane the change takes; absent is the full lane, as every report written before the fast one. */
		lane: z.enum(LANES).optional(),
		/** `git patch-id --stable` of `base..head` (`git diff --binary`): required on the fast lane. */
		patchId: z
			.string()
			.regex(
				/^[0-9a-f]{40}$/,
				"patchId is the 40-hex id `git patch-id --stable` prints",
			)
			.optional(),
	})
	.refine((r) => r.lane !== "fast" || r.patchId !== undefined, {
		path: ["patchId"],
		message:
			"a fast-lane report names the patch id of what it checked (`git diff --binary <base> <head> | git patch-id --stable`): core holds it to the patch id the approved preview served",
	})
	.refine((r) => r.lane === "fast" || r.patchId === undefined, {
		path: ["patchId"],
		message:
			'patchId is read only on the fast lane; a full-lane report sends none, or sends `lane: "fast"`',
	});
export type MergeCheckReport = z.infer<typeof mergeCheckReportSchema>;

export const MERGE_CHECK_SHAPE = `{ base: { branch, sha }, head, mode: pre-merge | landed, touched: [{ path, change }], checks: [${CHECK_RUN_SHAPE}], lane?: fast | full, patchId?: <40 hex, fast only> }`;

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
