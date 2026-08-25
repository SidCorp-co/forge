import { describe, expect, it } from "vitest";
import { describeCascade } from "./use-unblock-cascade";

describe("describeCascade", () => {
	it("names every dependent when none were truncated", () => {
		expect(
			describeCascade({
				blockerId: "b",
				blockerIssSeq: 7,
				dependents: [
					{ issueId: "a", issSeq: 12 },
					{ issueId: "b", issSeq: 13 },
				],
				overflow: 0,
			}),
		).toBe("ISS-12, ISS-13");
	});

	it("says how many the payload cap left out", () => {
		expect(
			describeCascade({
				blockerId: "b",
				blockerIssSeq: 7,
				dependents: [{ issueId: "a", issSeq: 12 }],
				overflow: 4,
			}),
		).toBe("ISS-12 +4 more");
	});
});
