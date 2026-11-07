// The merge check's record (Issue to release r20 `rule-merge`; REQ-36 BC-9, BC-15, BC-17; ISS-472):
// the report a project's merge check writes (`scripts/merge-check.mjs` in this repository), which
// `POST /api/issues/:id/merge-check` records on the issue and the merge mark then asks for. A report
// on the fast lane (REQ-39 BC-7, `./fast-lane.ts`) needs only `FAST_LANE_MERGE_CHECKS`. Every report
// names the patch id of what it checked: core holds a fast one to the patch id the approved preview
// served, and a reporter's confirm is matched to it on either lane (REQ-41 BC-20). A full-lane report
// from a script that predates patch ids is still taken, recorded with `PATCH_ID_ABSENT`.

import { z } from "zod";
import {
	CHECK_RUN_SHAPE,
	type CheckKind,
	checkRunsSchema,
	wholeShaSchema,
} from "./check-runs.js";
import { debtItemsSchema, HOLDING_RATING, impactSchema } from "./cleanup.js";
import { FAST_LANE_MERGE_CHECKS, LANES, type Lane } from "./fast-lane.js";
import { ARTIFACT_CHANGES } from "./landing-artifacts.js";
import { PATTERN_ENTRY_MISSING } from "./patterns.js";

/**
 * Every check a merge needs, by name. `probes` is the issue's kept probes, run against the change
 * (REQ-36 BC-9): one check per probe, bound to it by the report's `probes`. The review is its own
 * record, which the mark asks (`./issue-review.ts`).
 */
export const REQUIRED_MERGE_CHECKS = [
	"rebased-on-base",
	"typecheck",
	"direct-tests",
	"integration-tests",
	"probes",
	"verify",
] as const;
export type RequiredMergeCheck = (typeof REQUIRED_MERGE_CHECKS)[number];

/** The kind each required check is, so its time is counted where the issue page shows it. */
export const MERGE_CHECK_KINDS = {
	"rebased-on-base": "base",
	typecheck: "typecheck",
	"direct-tests": "tests",
	"integration-tests": "tests",
	probes: "probes",
	verify: "conformance",
} as const satisfies Record<RequiredMergeCheck, CheckKind>;

/** `pre-merge`: the change rebased on the latest base, before it lands. `landed`: already on it. */
export const MERGE_CHECK_MODES = ["pre-merge", "landed"] as const;
export type MergeCheckMode = (typeof MERGE_CHECK_MODES)[number];

const LIMITS = {
	checks: 200,
	touched: 2000,
	probes: 200,
	commits: 1000,
	reruns: 200,
} as const;

/** One probe the merge check ran: the criterion, the kept probe's id, and the `probes` check that ran it. */
const probeBindingSchema = z.strictObject({
	criterion: z.number().int().min(1),
	probe: z.uuid(
		"probe is the kept probe's id, as the criteria read answers it",
	),
	check: z.uuid(
		"check is the id of the `probes` check in this report that ran it",
	),
});
export type MergeProbeBinding = z.infer<typeof probeBindingSchema>;

/**
 * A criterion the check read as standing (ISS-472 round 5): its latest verdict, a pass, short or fail
 * on a commit the base carries, so the change did not claim it and owes it no probe. A fail standing
 * so is a standing fail (ISS-606): it stays the judge's fail, and the record names it apart. Core
 * holds `verdict` to the criterion's live latest; which commits the base carries is the box's word.
 */
const standingSchema = z.strictObject({
	criterion: z.number().int().min(1),
	verdict: z.uuid(
		"verdict is the id of the criterion's latest verdict, as the criteria read answers it",
	),
});
export type MergeStanding = z.infer<typeof standingSchema>;

/**
 * How a rerun of one red integration test file ended (ISS-1120): `absent` is a file the merge base
 * does not hold, `error` a run that could not be made (the base's install or build failed).
 */
export const RERUN_RESULTS = ["pass", "fail", "absent", "error"] as const;
export type RerunResult = (typeof RERUN_RESULTS)[number];

/**
 * What a rerun makes of a red integration test file: `base-red` is red at the merge base too,
 * `flaky` went green on its rerun at the head, and `branch-red` is the change's own red, refused as
 * every red is. Base-red and flaky are not the change's: the record names them apart and passes.
 */
export const RERUN_VERDICTS = ["base-red", "flaky", "branch-red"] as const;
export type RerunVerdict = (typeof RERUN_VERDICTS)[number];

/** The verdict a rerun's outcomes bear: green again at the head is flaky, red at the base too is base-red. */
export function rerunVerdictOf(
	head: RerunResult,
	base: RerunResult | null,
): RerunVerdict {
	if (head === "pass") return "flaky";
	return head === "fail" && base === "fail" ? "base-red" : "branch-red";
}

const rerunRunSchema = z.strictObject({
	at: z.enum(["head", "base"]),
	sha: wholeShaSchema("reruns[].runs[].sha"),
	result: z.enum(RERUN_RESULTS),
	command: z.string().max(500),
	startedAt: z.iso.datetime({ offset: true }),
	durationMs: z.number().int().nonnegative().max(86_400_000),
	note: z.string().max(500).optional(),
});

/**
 * One red file of a red `integration-tests` check, rerun once at the head and, where it stayed red,
 * once at the merge base (ISS-1120), with the evidence of each run. Which files went red, and which
 * commit the merge base is, is the box's word, as `standing` is.
 */
const rerunSchema = z.strictObject({
	check: z.uuid(
		"check is the id of the red `integration-tests` check in this report whose file was rerun",
	),
	file: z.string().min(1).max(1000),
	verdict: z.enum(RERUN_VERDICTS),
	runs: z.array(rerunRunSchema).min(1).max(2),
});
export type MergeRerun = z.infer<typeof rerunSchema>;

/**
 * The checks a report needs: on the fast lane, or on a project delivering fast (REQ-79 BC-2: a change
 * lands when it builds and its scoped tests pass), the three of `FAST_LANE_MERGE_CHECKS`; else every
 * one a merge needs.
 */
export function requiredMergeChecksOf(
	lane: Lane | undefined,
	fastDelivery = false,
): readonly RequiredMergeCheck[] {
	return lane === "fast" || fastDelivery
		? FAST_LANE_MERGE_CHECKS
		: REQUIRED_MERGE_CHECKS;
}

export const mergeCheckReportSchema = z
	.strictObject({
		base: z.strictObject({
			branch: z.string().trim().min(1).max(200),
			sha: wholeShaSchema("base.sha"),
		}),
		head: wholeShaSchema("head"),
		/**
		 * The commits the check covered, `git rev-list base..head`, head included (REQ-79 BC-5): a mark
		 * at any of them is covered by this check, so an issue landed mid-batch is marked on the
		 * batch's later passing check. Absent is the head alone, as every report before ISS-845's.
		 */
		commits: z
			.array(wholeShaSchema("commits[]"))
			.max(LIMITS.commits)
			.optional(),
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
		/**
		 * Which kept probe each `probes` check ran. Core holds them to the probes the issue keeps:
		 * one not run is MERGE_PROBE_MISSING, one red MERGE_PROBE_RED. Absent is none run.
		 */
		probes: z.array(probeBindingSchema).max(LIMITS.probes).optional(),
		/**
		 * The criteria the check read as standing, each owing no probe. Absent is none: every
		 * criterion is the change's, as a report from a script older than round 5 reads.
		 */
		standing: z.array(standingSchema).max(LIMITS.probes).optional(),
		/**
		 * Each red integration test file, rerun at the head and at the merge base (ISS-1120). A red
		 * `integration-tests` check whose every rerun is `base-red` or `flaky` is not the change's red.
		 * Absent is none rerun: every red is the change's, as a report before ISS-1120 reads.
		 */
		reruns: z.array(rerunSchema).max(LIMITS.reruns).optional(),
		/** The lane the change takes; absent is the full lane, as every report written before the fast one. */
		lane: z.enum(LANES).optional(),
		/**
		 * `git patch-id --stable` of `base..head` (`git diff --binary`). Required on the fast lane (core
		 * holds it to the approved preview's); sent on the full lane too, where a reporter's confirm is
		 * matched to it (REQ-41 BC-20). A full-lane report without one is a priced amnesty: it is recorded
		 * with `PATCH_ID_ABSENT` and the response says so (scripts/README.md, merge-check row).
		 */
		patchId: z
			.string()
			.regex(
				/^[0-9a-f]{40}$/,
				"patchId is the 40-hex id `git patch-id --stable` prints",
			)
			.optional(),
		/** The building agent's rating of its change (REQ-79 BC-4), recorded with the check. */
		impact: impactSchema.optional(),
		/**
		 * Reds the check passes as cleanup debt on a project delivering fast (REQ-79 BC-3): each red
		 * check is named by a `red` debt whose `check` is its name, rated below high. A red rated high
		 * holds the change, so it is never debt.
		 */
		debts: debtItemsSchema.optional(),
	})
	.superRefine((r, ctx) => {
		for (const [i, s] of (r.standing ?? []).entries()) {
			if (
				(r.standing ?? []).findIndex((o) => o.criterion === s.criterion) !== i
			) {
				ctx.addIssue({
					code: "custom",
					path: ["standing", i, "criterion"],
					message: `criterion ${s.criterion} is named standing twice; each criterion stands on one verdict`,
				});
			}
		}
		for (const [i, d] of (r.debts ?? []).entries()) {
			if (d.kind === "red" && d.impact.rating === HOLDING_RATING) {
				ctx.addIssue({
					code: "custom",
					path: ["debts", i, "impact", "rating"],
					message: `a red rated ${HOLDING_RATING} holds the change and is fixed in it, so it is never cleanup debt (REQ-79 BC-3)`,
				});
			}
		}
		for (const [i, x] of (r.reruns ?? []).entries()) {
			const at = (key: string | number) => ["reruns", i, key];
			const red = r.checks.find((c) => c.id === x.check);
			if (red?.name !== "integration-tests" || red.result !== "fail") {
				ctx.addIssue({
					code: "custom",
					path: at("check"),
					message: `check ${x.check} is not a red \`integration-tests\` check of this report, so it has no red file to rerun`,
				});
			} else if (!red.files.includes(x.file)) {
				ctx.addIssue({
					code: "custom",
					path: at("file"),
					message: `${x.file} is a file check ${x.check} did not run, so it cannot have gone red there`,
				});
			}
			const twice = (r.reruns ?? []).findIndex(
				(o) => o.check === x.check && o.file === x.file,
			);
			if (twice !== i) {
				ctx.addIssue({
					code: "custom",
					path: at("file"),
					message: `${x.file} is rerun twice for check ${x.check}; each red file is rerun once`,
				});
			}
			const heads = x.runs.filter((run) => run.at === "head");
			const bases = x.runs.filter((run) => run.at === "base");
			const head = heads[0];
			if (
				heads.length !== 1 ||
				!head ||
				head.sha.toLowerCase() !== r.head.toLowerCase()
			) {
				ctx.addIssue({
					code: "custom",
					path: at("runs"),
					message: `${x.file} is rerun once at the head checked, ${r.head.slice(0, 12)}, before anything is made of its red`,
				});
				continue;
			}
			if (bases.length > 1) {
				ctx.addIssue({
					code: "custom",
					path: at("runs"),
					message: `${x.file} is rerun at the merge base once at most`,
				});
			}
			const bears = rerunVerdictOf(head.result, bases[0]?.result ?? null);
			if (bears !== x.verdict) {
				ctx.addIssue({
					code: "custom",
					path: at("verdict"),
					message: `${x.file} is named ${x.verdict}, and its runs (head ${head.result}, base ${bases[0]?.result ?? "not run"}) make it ${bears}`,
				});
			}
		}
		for (const [i, b] of (r.probes ?? []).entries()) {
			const ran = r.checks.find((c) => c.id === b.check);
			if (ran?.kind !== "probes") {
				ctx.addIssue({
					code: "custom",
					path: ["probes", i, "check"],
					message: `check ${b.check} is not a \`probes\` check of this report, so it cannot be what ran probe ${b.probe}`,
				});
			}
		}
	})
	.refine((r) => r.lane !== "fast" || r.patchId !== undefined, {
		path: ["patchId"],
		message:
			"a fast-lane report names the patch id of what it checked (`git diff --binary <base> <head> | git patch-id --stable`): core holds it to the patch id the approved preview served",
	});
export type MergeCheckReport = z.infer<typeof mergeCheckReportSchema>;

export const MERGE_CHECK_SHAPE = `{ base: { branch, sha }, head, mode: pre-merge | landed, touched: [{ path, change }], checks: [${CHECK_RUN_SHAPE}], probes?: [{ criterion, probe: <kept probe id>, check: <id of the probes check that ran it> }], standing?: [{ criterion, verdict: <its latest verdict's id, a pass, short or fail at a commit the base carries> }], reruns?: [{ check: <id of a red integration-tests check>, file, verdict: base-red | flaky | branch-red, runs: [{ at: head | base, sha, result: pass | fail | absent | error, command, startedAt, durationMs, note? }] }], lane?: fast | full, patchId?: <40 hex, required on the fast lane>, impact?: { type, rating: low | medium | high, reason }, debts?: [{ kind: red | debt | simplify, check?, where, detail, impact }] }`;

/** A kept probe of a criterion the change claims that the report did not run, a claimed observable criterion keeping none, or a standing reading core does not hold. */
export const MERGE_PROBE_MISSING = "MERGE_PROBE_MISSING" as const;
/** A kept probe the report ran that answered something other than what it expects. */
export const MERGE_PROBE_RED = "MERGE_PROBE_RED" as const;

/** A mark where a merge check is owed and none passed at the commit marked. */
export const MERGE_CHECK_MISSING = "MERGE_CHECK_MISSING" as const;

// The registry of the codes a merge check refuses by: enumerating them IS the point, so each new
// refusal is added here and `MergeCheckRefusalCode` is derived from this list.
export const MERGE_CHECK_REFUSAL_CODES = [
	"MERGE_CHECK_REFUSED",
	"MERGE_CHECK_RED",
	"MERGE_BEHIND_BASE",
	"MERGE_CHECK_INCOMPLETE",
	"MERGE_CHECK_KIND_MISMATCH",
	MERGE_PROBE_MISSING,
	MERGE_PROBE_RED,
	PATTERN_ENTRY_MISSING,
	/** A report passing reds as cleanup debt on a project that turned fast delivery off (REQ-79 BC-1). */
	"MERGE_DEBT_FAST_DELIVERY_OFF",
] as const;
export type MergeCheckRefusalCode = (typeof MERGE_CHECK_REFUSAL_CODES)[number];

/** What a record's `patch-id` field reads when a full-lane report sent none (a script older than patch ids). */
export const PATCH_ID_ABSENT = "absent (script predates patch ids)";

/** The `verification` record a passing check is kept as: its `check` field reads this. */
export const MERGE_CHECK_RECORD = "merge";
