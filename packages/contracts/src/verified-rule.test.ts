import { describe, expect, it } from "vitest";
import {
	BUILDER_PASS_CUTOVER,
	countedUnderCutover,
	judgesVerdict,
	notCountedOf,
	releaseCounts,
	reopenVoidWhy,
	RELEASE_DELIVERY,
	unverifiedWhy,
	verifiedOf,
	voidedByReopen,
	voidedUnder,
} from "./verified-rule.js";

/** After the builder-pass cutover, where the rule reads as it will once the amnesty ends. */
const AFTER = "2026-10-26T09:00:00Z";
const BEFORE = "2026-10-20T09:00:00Z";

const v = (
	verdict: string,
	byBuilder = false,
	authored = true,
	recordedAt: string | null = AFTER,
) => ({
	verdict,
	byBuilder,
	authored,
	recordedAt,
});

describe("the verified rule every count of proof reads (REQ-35 decision 7b261fca)", () => {
	it("proves a criterion only by a pass; a short never, under any judge", () => {
		for (const judge of [null, "self", "independent"] as const) {
			expect(verifiedOf([v("short")], judge)).toMatchObject({
				proven: false,
				why: "judged short: met short of its wording, and only a pass counts as verified",
			});
			expect(verifiedOf([v("pass")], judge).proven).toBe(true);
			expect(verifiedOf([v("fail")], judge)).toMatchObject({
				proven: false,
				why: null,
			});
		}
		expect(verifiedOf([], null)).toEqual({
			stands: null,
			proven: false,
			why: null,
		});
	});

	it("never counts the builder's own pass, whatever the project's qa says (REQ-74 BC-2)", () => {
		for (const judge of [null, "self", "independent"] as const) {
			expect(unverifiedWhy(v("pass", true), judge)).toBe(
				"passed by the run that built it, and a builder's own pass never counts",
			);
			expect(verifiedOf([v("pass", true)], judge).proven).toBe(false);
		}
	});

	it("keeps counting a builder's pass recorded before the cutover, marked, except under an independent judge", () => {
		for (const judge of [null, "self"] as const) {
			const early = v("pass", true, true, BEFORE);
			expect(verifiedOf([early], judge).proven).toBe(true);
			expect(countedUnderCutover(early, judge)).toBe(true);
			expect(notCountedOf(early, judge)).toBeNull();
		}
		const early = v("pass", true, true, BEFORE);
		expect(verifiedOf([early], "independent").proven).toBe(false);
		expect(countedUnderCutover(early, "independent")).toBe(false);
		expect(countedUnderCutover(v("pass", false, true, BEFORE), "self")).toBe(false);
	});

	it("counts no builder's pass recorded at the cutover or after it, and names why", () => {
		for (const judge of [null, "self", "independent"] as const) {
			const at = v("pass", true, true, BUILDER_PASS_CUTOVER);
			expect(verifiedOf([at], judge).proven).toBe(false);
			expect(countedUnderCutover(at, judge)).toBe(false);
			expect(notCountedOf(v("pass", true), judge)?.code).toBe("VERDICT_BY_BUILDER");
		}
	});

	it("counts an unauthored pass only where no independent judge is declared", () => {
		expect(unverifiedWhy(v("pass", false, false), "independent")).toContain(
			"no recorded author",
		);
		expect(unverifiedWhy(v("pass", false, false), "self")).toBeNull();
	});

	it("reads a judge's older pass past a newer verdict of the builder's, never past a fail", () => {
		for (const qa of [null, "self", "independent"] as const) {
			const judge = v("pass");
			expect(judgesVerdict([v("short", true), judge], qa)).toBe(judge);
			const fail = v("fail", true);
			expect(judgesVerdict([fail, judge], qa)).toBe(fail);
		}
		expect(judgesVerdict([v("pass", false, false), v("pass")], "self")?.authored).toBe(
			false,
		);
	});

	it("voids every verdict recorded at or before the issue's last reopen, and says to judge it again (ISS-55)", () => {
		const reopen = "2026-10-23T07:13:00Z";
		const at = v("pass", false, true, reopen);
		const after = v("pass", false, true, "2026-10-23T07:13:00.001Z");
		expect(voidedByReopen(at, reopen), "the very instant of the reopen is before it").toBe(true);
		expect(voidedByReopen(after, reopen)).toBe(false);
		expect(voidedByReopen(at, null), "an issue never reopened voids nothing").toBe(false);
		expect(reopenVoidWhy(reopen)).toBe(
			"recorded before the reopen on 2026-10-23 07:13 UTC; judge it again",
		);
		for (const judge of [null, "self", "independent"] as const) {
			expect(verifiedOf([at], judge, reopen)).toEqual({
				stands: null,
				proven: false,
				why: reopenVoidWhy(reopen),
			});
			expect(verifiedOf([after, at], judge, reopen)).toMatchObject({ stands: after, proven: true });
		}
		// a builder's pre-cutover pass the amnesty counts is voided by the reopen like any other
		expect(verifiedOf([v("pass", true, true, BEFORE)], "self", AFTER).proven).toBe(false);
		// a voided fail or skip owes no reason: only a pass or short claims anything
		expect(verifiedOf([v("fail", false, true, reopen)], "self", reopen).why).toBeNull();
		expect(verifiedOf([v("short", false, true, reopen)], "self", reopen).why).toBe(
			reopenVoidWhy(reopen),
		);
	});

	it("counts on a release only a proven criterion whose verdict names a resolved commit", () => {
		const on = (identityKind: string | null) => ({ ...v("pass"), identityKind });
		expect(releaseCounts(verifiedOf([on("commit")], "self"))).toEqual({
			counted: true,
			unresolved: false,
		});
		expect(releaseCounts(verifiedOf([on("commit_unresolved")], "self"))).toEqual({
			counted: false,
			unresolved: true,
		});
		const failed = { ...on("commit_unresolved"), verdict: "fail" };
		expect(releaseCounts(verifiedOf([failed], "self"))).toEqual({
			counted: false,
			unresolved: false,
		});
	});

	it("voids a pass from before the reopen by the project's delivery: always on a release, kept at the landed commit on a landing", () => {
		const reopen = "2026-10-23T07:13:00Z";
		const landed = "f".repeat(40);
		const before = { recordedAt: "2026-10-23T07:07:16Z", commit: landed };
		const landing = { mode: "landing", landed } as const;
		expect(voidedUnder(before, reopen, RELEASE_DELIVERY)).toBe(true);
		expect(voidedUnder(before, reopen, landing)).toBe(false);
		expect(voidedUnder({ ...before, commit: "d".repeat(40) }, reopen, landing)).toBe(true);
		expect(voidedUnder({ ...before, commit: null }, reopen, landing)).toBe(true);
		expect(voidedUnder(before, reopen, { mode: "landing", landed: null })).toBe(true);
		const after = { recordedAt: "2026-10-23T07:14:00Z", commit: null };
		expect(voidedUnder(after, reopen, RELEASE_DELIVERY), "after the reopen nothing voids it").toBe(false);
		const pass = { ...v("pass", false, true, before.recordedAt), identityKind: "commit", commitSha: landed };
		expect(verifiedOf([pass], "self", reopen, landing).proven).toBe(true);
		expect(verifiedOf([pass], "self", reopen).proven).toBe(false);
	});
});
