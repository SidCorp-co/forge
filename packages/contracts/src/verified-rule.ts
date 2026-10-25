// The verified rule (REQ-35, decision 7b261fca; REQ-74 BC-2): what proves a criterion, read the same by
// every count of proof — a requirement's coverage (core `requirements/standing-coverage.ts:coverageOf`),
// a release page's proven list (core `release-page/claims.ts:readClaims`), a release record's totals,
// Proof panel, per-issue proof and approval checklist (core `release-batch/release-facts.ts:criteriaAt`)
// and the criteria hold that "Ship only proven work" names (core
// `issues/criteria-verdicts.ts:unearnedCriteriaReports`). Only a pass from someone other than the
// builder proves it, whatever the project's `qa` says: the builder's own pass is its evidence, kept
// with its probe, and never its proof (core `issues/built-by.ts` names the builder), save the ones
// recorded before `BUILDER_PASS_CUTOVER`, an amnesty with its end condition. A verdict recorded at or
// before the issue's last reopen is about a build the reopen rejected (`voidedByReopen`, ISS-55), so
// no release counts it and the issue's criteria read says so (core `issues/criteria/counting.ts`). A short is met
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
): NotCounted | null {
	if (!barred(v, judge)) return null;
	if (v.verdict !== "pass" && v.verdict !== "short") return null;
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

/**
 * Whether a verdict was recorded at or before the issue's last reopen (ISS-55): evidence about a
 * build the reopen rejected, so it is not current and no release counts it. The one void every
 * count of proof reads, by way of `verifiedOf` or directly where a reader keeps the voided row.
 */
export function voidedByReopen(
	v: Pick<JudgedVerdict, "recordedAt">,
	reopenedAt: string | Date | null,
): boolean {
	if (reopenedAt === null || v.recordedAt === null) return false;
	return new Date(v.recordedAt).getTime() <= new Date(reopenedAt).getTime();
}

/** Why a pass or short the issue's last reopen voided does not count: what a judge does about it. */
export function reopenVoidWhy(reopenedAt: string | Date): string {
	const at = new Date(reopenedAt).toISOString().slice(0, 16).replace("T", " ");
	return `recorded before the reopen on ${at} UTC; judge it again`;
}

/** A criterion read by the verified rule: the verdict it stands on, and whether that proves it. */
export interface Verified<V> {
	/** The verdict the criterion stands on (`judgesVerdict`), or null where it has none. */
	stands: V | null;
	/** Whether `stands` is a pass the rule counts as verified. */
	proven: boolean;
	/**
	 * Where `stands` is a pass or short that does not count, why (`unverifiedWhy`); where every verdict
	 * was voided by the reopen and the newest was a pass or short, `reopenVoidWhy`; else null.
	 */
	why: string | null;
}

/**
 * Whether a criterion whose verdicts are `newestFirst` is proven, by the verified rule. Given the
 * issue's last reopen, a verdict recorded at or before it is not read (`voidedByReopen`).
 */
export function verifiedOf<V extends JudgedVerdict>(
	newestFirst: readonly V[],
	judge: PolicyQaMode | null,
	reopenedAt: string | Date | null = null,
): Verified<V> {
	const current = newestFirst.filter((v) => !voidedByReopen(v, reopenedAt));
	const stands = judgesVerdict(current, judge) ?? null;
	if (!stands) {
		const voided = newestFirst[0];
		const answered = voided?.verdict === "pass" || voided?.verdict === "short";
		const why = reopenedAt !== null && answered ? reopenVoidWhy(reopenedAt) : null;
		return { stands: null, proven: false, why };
	}
	const why = unverifiedWhy(stands, judge);
	return { stands, proven: stands.verdict === "pass" && why === null, why };
}

/** Why a pass on a backfilled abbreviation never counts on a release: it names no build (`commit_unresolved`). */
export const UNRESOLVED_COMMIT_WHY =
	"judged on an abbreviated commit that was backfilled and never resolved, so no build is shown to hold it; judge it again on a whole commit";

/**
 * Whether a release counts a criterion read by the verified rule (`verifiedOf`): only where it is
 * proven and the verdict it stands on names a commit that resolved, read the same by the release
 * record (core `release-batch/release-facts.ts:criteriaAt`) and the issue's criteria read (core
 * `issues/criteria/counting.ts`). `unresolved` is set where only the abbreviation keeps it from
 * counting, so a reader may name it.
 */
export function releaseCounts<
	V extends JudgedVerdict & { identityKind: string | null },
>(read: Verified<V>): { counted: boolean; unresolved: boolean } {
	const unresolved =
		read.proven && read.stands?.identityKind === "commit_unresolved";
	return { counted: read.proven && !unresolved, unresolved };
}
