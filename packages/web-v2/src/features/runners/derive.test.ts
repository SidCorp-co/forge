import { describe, expect, it } from "vitest";
import { runnerLimitDisplay } from "./types";

const NOW = Date.parse("2026-06-22T08:00:00.000Z");

describe("runnerLimitDisplay", () => {
	it("returns null when the runner is not limited", () => {
		expect(
			runnerLimitDisplay(
				{ limitReason: null, rateLimitedUntil: null, limitDetail: null },
				NOW,
			),
		).toBeNull();
	});

	it("derives an active usage limit with a future reset time", () => {
		const out = runnerLimitDisplay(
			{
				limitReason: "usage_limit",
				rateLimitedUntil: "2026-06-22T08:42:00.000Z",
				limitDetail: "out of extra usage",
			},
			NOW,
		);
		expect(out).not.toBeNull();
		expect(out!.label).toBe("Usage limit");
		expect(out!.health).toBe("attention");
		expect(out!.active).toBe(true);
		expect(out!.resetText).toBe("resets in 42m");
	});

	it("formats multi-hour resets", () => {
		const out = runnerLimitDisplay(
			{
				limitReason: "rate_limit",
				rateLimitedUntil: "2026-06-22T10:30:00.000Z",
				limitDetail: null,
			},
			NOW,
		);
		expect(out!.resetText).toBe("resets in 2h 30m");
	});

	it("marks a passed reset time as inactive but still surfaces it", () => {
		const out = runnerLimitDisplay(
			{
				limitReason: "rate_limit",
				rateLimitedUntil: "2026-06-22T07:00:00.000Z",
				limitDetail: null,
			},
			NOW,
		);
		expect(out!.active).toBe(false);
		expect(out!.resetText).toBe("reset passed");
	});

	it("treats auth as a down-tone limit with no reset time", () => {
		const out = runnerLimitDisplay(
			{
				limitReason: "auth",
				rateLimitedUntil: null,
				limitDetail: "API Error: 401 Invalid authentication credentials",
			},
			NOW,
		);
		expect(out!.health).toBe("down");
		expect(out!.active).toBe(true);
		expect(out!.resetText).toBeNull();
	});
});
