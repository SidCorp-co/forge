import { describe, expect, it } from "vitest";
import { judgesVerdict, unverifiedWhy, verifiedOf } from "./verified-rule.js";

const v = (verdict: string, byBuilder = false, authored = true) => ({
	verdict,
	byBuilder,
	authored,
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

	it("under an independent judge, counts neither the builder's pass nor an unauthored one", () => {
		expect(unverifiedWhy(v("pass", true), "independent")).toContain(
			"passed by the run that built it",
		);
		expect(unverifiedWhy(v("pass", false, false), "independent")).toContain(
			"no recorded author",
		);
		expect(unverifiedWhy(v("pass", true), "self")).toBeNull();
	});

	it("reads the judge's older pass past a newer verdict of the builder's, never past a fail", () => {
		const judge = v("pass");
		expect(judgesVerdict([v("short", true), judge], "independent")).toBe(judge);
		const fail = v("fail", true);
		expect(judgesVerdict([fail, judge], "independent")).toBe(fail);
		expect(judgesVerdict([v("short", true), judge], null)?.verdict).toBe(
			"short",
		);
	});
});
