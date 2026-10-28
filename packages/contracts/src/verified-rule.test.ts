import { describe, expect, it } from "vitest";
import {
	BUILDER_PASS_CUTOVER,
	countedUnderCutover,
	judgesVerdict,
	notCountedOf,
	unverifiedWhy,
	verifiedOf,
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
				"passed by the run that built it, and a builder's own pass never counts where gate `builder_verdict` is enforced (gates.overrides.builder_verdict relaxes it)",
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
});
