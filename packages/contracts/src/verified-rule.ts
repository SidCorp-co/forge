// The verified rule (REQ-35, decision 7b261fca; REQ-74 BC-2): what proves a criterion, read the same by
// every count of proof — a requirement's coverage (core `requirements/standing-coverage.ts:coverageOf`),
// a release page's proven list (core `release-page/claims.ts:readClaims`), a release record's totals,
// Proof panel, per-issue proof and approval checklist (core `release-batch/release-facts.ts:criteriaAt`)
// and the criteria hold that "Ship only proven work" names (core
// `issues/criteria-verdicts.ts:unearnedCriteriaReports`). Only a pass from someone other than the
// builder proves it, whatever the project's `qa` says: the builder's own pass is its evidence, kept
// with its probe, and never its proof (core `issues/built-by.ts` names the builder), save the ones
// recorded before `BUILDER_PASS_CUTOVER`, an amnesty with its end condition. A short is met
// short of its wording, not verified, so it never does. Where the project declares an independent
// judge, a pass that names no author is not that judge's either, since nothing shows it came from
// anyone else. A fail counts whoever records it: it is evidence the criterion does not hold, and
// verification is only owed for a claim that it does. Pure: each reader hands it the verdicts it read.

import type { PolicyQaMode } from "./project-config.js";

/** What the verified rule reads of a verdict: what it said, who recorded it, and when. */
export interface JudgedVerdict {
	verdict: string | null;
	/** Recorded by the issue's builder (core `issues/built-by.ts`); false where there is no verdict. */
	byBuilder: boolean;
	/** Names who recorded it, an account or a box; false where there is no verdict. */
	authored: boolean;
	/** When it was recorded; null where there is no verdict. Read against `BUILDER_PASS_CUTOVER`. */
	recordedAt: string | Date | null;
}

/**
 * AMNESTY (ISS-683, REQ-74 BC-2): when the rule that a builder's own pass never counts took effect,
 * whatever the project's `qa`. Before it, a project without an independent judge counted the
 * building run's pass, and those verdicts were already read as proof by releases and requirements
 * still waiting on them.
 * - Traded: a builder's pass recorded before this instant keeps counting where it counted then (any
 *   project but one declaring an independent judge); one recorded at or after it never counts.
 * - Cost: the criteria standing on such a pass were never judged by anyone but their builder. Each
 *   one is shown as such (`countedUnderCutover`), never hidden.
 * - Ends when: every issue holding a pre-cutover builder pass is closed or judged again by another
 *   run. Then this constant and `underCutover` are deleted, and the builder's pass never counts.
 */
export const BUILDER_PASS_CUTOVER = "2026-10-25T17:00:00Z";
const CUTOVER_MS = Date.parse(BUILDER_PASS_CUTOVER);

/** A builder's verdict the amnesty still counts: recorded before the cutover, on a project with no independent judge. */
function underCutover(v: JudgedVerdict, judge: PolicyQaMode | null): boolean {
	if (!v.byBuilder || judge === "independent" || v.recordedAt === null) return false;
	return new Date(v.recordedAt).getTime() < CUTOVER_MS;
}

/** A builder's verdict the rule bars: every one but those the amnesty still counts. */
const barred = (v: JudgedVerdict, judge: PolicyQaMode | null) =>
	v.byBuilder && !underCutover(v, judge);

/** Whether a builder's pass counts only by the amnesty (`BUILDER_PASS_CUTOVER`), so a reader can say so. */
export function countedUnderCutover(
	v: JudgedVerdict,
	judge: PolicyQaMode | null,
): boolean {
	return v.verdict === "pass" && underCutover(v, judge);
}

/** Why a verdict does not count as verified, or null where it does, or is a fail, a skip or none. */
export function unverifiedWhy(
	v: JudgedVerdict,
	judge: PolicyQaMode | null,
): string | null {
	if (v.verdict === "short") {
		return "judged short: met short of its wording, and only a pass counts as verified";
	}
	if (v.verdict !== "pass") return null;
	if (barred(v, judge)) {
		return "passed by the run that built it, and a builder's own pass never counts";
	}
	if (judge === "independent" && !v.authored) {
		return "passed with no recorded author, so nothing shows it is the independent judge's";
	}
	return null;
}

/** The name a verdict is answered with where it is kept and never counts: the building run's own pass or short (ISS-475, REQ-74 BC-2). */
export const VERDICT_BY_BUILDER = "VERDICT_BY_BUILDER";

/** Why a verdict just recorded will never count as verified, by name; null where it may. */
export interface NotCounted {
	code: typeof VERDICT_BY_BUILDER;
	detail: string;
}

/**
 * What a verdict's write answers about counting (REQ-36 BC-16, REQ-74 BC-2): whatever the project's
 * `qa`, the building run's pass or short is kept as that run's evidence, with its probe (BC-6), and
 * named here, since no count of proof will ever read it (`unverifiedWhy`). A fail counts whoever
 * records it.
 */
export function notCountedOf(
	v: JudgedVerdict,
	judge: PolicyQaMode | null,
	/** The status the recording run was declared over the issue at, where that, before any merge, is why it reads as the builder (core `built-by.ts:declaredBeforeLandingSql`). */
	declaredAt: string | null = null,
): NotCounted | null {
	if (!barred(v, judge)) return null;
	if (v.verdict !== "pass" && v.verdict !== "short") return null;
	if (declaredAt !== null) {
		return {
			code: VERDICT_BY_BUILDER,
			detail: `recorded by a run declared while this issue stood at \`${declaredAt}\` with no merge recorded, and a run declared before the work landed is read as the run that built it: this verdict is kept as that run's evidence and never counts, whatever the project's \`qa\`. Once the work has landed, record its merge (\`POST /api/issues/:id/merge\`), move the issue to its landed status (\`awaiting_release\`) and declare a new judge run over it; that run's verdicts count`,
		};
	}
	return {
		code: VERDICT_BY_BUILDER,
		detail:
			"recorded by the run that built this issue, so it is kept as that run's evidence and never counts, whatever the project's `qa`: another run judges it on the release that carries the work. A judge on the building run's box names itself in `run`",
	};
}

/** Whether a verdict is not a judge's: anything but a fail, from the builder (`barred`), or from nobody named where an independent judge is declared. */
const notTheJudges = (v: JudgedVerdict, judge: PolicyQaMode | null) =>
	v.verdict !== null &&
	v.verdict !== "fail" &&
	(barred(v, judge) || (judge === "independent" && !v.authored));

/**
 * Of verdicts newest first, the one a criterion stands on: the newest, unless it is not a judge's
 * (`notTheJudges`), then the newest judge's where there is one. A newer verdict that is not a judge's
 * does not take a judge's older one away; a fail is everyone's, so it is never read past.
 */
export function judgesVerdict<V extends JudgedVerdict>(
	newestFirst: readonly V[],
	judge: PolicyQaMode | null,
): V | undefined {
	const [latest, ...earlier] = newestFirst;
	if (!latest || !notTheJudges(latest, judge)) return latest;
	return earlier.find((v) => !notTheJudges(v, judge)) ?? latest;
}

/** A criterion read by the verified rule: the verdict it stands on, and whether that proves it. */
export interface Verified<V> {
	/** The verdict the criterion stands on (`judgesVerdict`), or null where it has none. */
	stands: V | null;
	/** Whether `stands` is a pass the rule counts as verified. */
	proven: boolean;
	/** Where `stands` is a pass or short that does not count, why (`unverifiedWhy`); else null. */
	why: string | null;
}

/** Whether a criterion whose verdicts are `newestFirst` is proven, by the verified rule. */
export function verifiedOf<V extends JudgedVerdict>(
	newestFirst: readonly V[],
	judge: PolicyQaMode | null,
): Verified<V> {
	const stands = judgesVerdict(newestFirst, judge) ?? null;
	if (!stands) return { stands: null, proven: false, why: null };
	const why = unverifiedWhy(stands, judge);
	return { stands, proven: stands.verdict === "pass" && why === null, why };
}
