// The verified rule (REQ-35, decision 7b261fca): what proves a criterion, read the same by every
// count of proof — a requirement's coverage (core `requirements/standing-coverage.ts:coverageOf`), a
// release page's proven list (core `release-page/claims.ts:readClaims`), a release record's totals,
// Proof panel, per-issue proof and approval checklist (core `release-batch/release-facts.ts:criteriaAt`)
// and the criteria hold that "Ship only proven work" names (core
// `issues/criteria-verdicts.ts:unearnedCriteriaReports`). Only a pass from someone other than the
// builder proves it. A short is met short of its wording, not verified, so it never does. Where the
// project declares an independent judge, a pass the builder recorded is not that judge's, and neither
// is one that names no author, since nothing shows it came from anyone else; under `self`, or with no
// policy declared, the builder is the judge the project named and its pass counts. A fail counts
// whoever records it: it is evidence the criterion does not hold, and verification is only owed for a
// claim that it does. Pure: each reader hands it the verdicts it read.

import type { PolicyQaMode } from "./project-config.js";

/** What the verified rule reads of a verdict: what it said, and who recorded it. */
export interface JudgedVerdict {
	verdict: string | null;
	/** Recorded by the issue's builder (core `issues/built-by.ts`); false where there is no verdict. */
	byBuilder: boolean;
	/** Names who recorded it, an account or a box; false where there is no verdict. */
	authored: boolean;
}

/** Why a verdict does not count as verified, or null where it does, or is a fail, a skip or none. */
export function unverifiedWhy(
	v: JudgedVerdict,
	judge: PolicyQaMode | null,
): string | null {
	if (v.verdict === "short") {
		return "judged short: met short of its wording, and only a pass counts as verified";
	}
	if (v.verdict !== "pass" || judge !== "independent") return null;
	if (!v.authored) {
		return "passed with no recorded author, so nothing shows it is the independent judge's";
	}
	if (v.byBuilder) {
		return "passed by the run that built it, and this project counts only a pass from its independent judge";
	}
	return null;
}

/** The name a verdict is answered with where it is kept and never counts: the building run's own pass or short under an independent judge (ISS-475). */
export const VERDICT_BY_BUILDER = "VERDICT_BY_BUILDER";

/** Why a verdict just recorded will never count as verified, by name; null where it may. */
export interface NotCounted {
	code: typeof VERDICT_BY_BUILDER;
	detail: string;
}

/**
 * What a verdict's write answers about counting (REQ-36 BC-16): under an independent judge, the
 * building run's pass or short is kept as that run's evidence, with its probe (BC-6), and named here,
 * since no count of proof will ever read it (`unverifiedWhy`). A fail counts whoever records it.
 */
export function notCountedOf(
	v: JudgedVerdict,
	judge: PolicyQaMode | null,
): NotCounted | null {
	if (judge !== "independent" || !v.byBuilder) return null;
	if (v.verdict !== "pass" && v.verdict !== "short") return null;
	return {
		code: VERDICT_BY_BUILDER,
		detail:
			"recorded by the run that built this issue, so it is kept as that run's evidence and never counts: this project counts only its independent judge's verdict, judged on the release that carries the work. A judge on the building run's box names itself in `run`",
	};
}

/** Whether a verdict is not the independent judge's: anything but a fail, from the builder or from nobody named. */
const notTheJudges = (v: JudgedVerdict) =>
	v.verdict !== null && v.verdict !== "fail" && (v.byBuilder || !v.authored);

/**
 * Of verdicts newest first, the one a criterion stands on: the newest, unless the project names an
 * independent judge and the newest is not theirs, then the judge's newest where there is one. A newer
 * verdict that is not the judge's does not take the judge's older one away; a fail is everyone's, so
 * it is never read past.
 */
export function judgesVerdict<V extends JudgedVerdict>(
	newestFirst: readonly V[],
	judge: PolicyQaMode | null,
): V | undefined {
	const [latest, ...earlier] = newestFirst;
	if (!latest || judge !== "independent" || !notTheJudges(latest))
		return latest;
	return earlier.find((v) => !notTheJudges(v)) ?? latest;
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
