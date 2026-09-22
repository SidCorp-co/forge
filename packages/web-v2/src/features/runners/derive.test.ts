import { describe, expect, it } from "vitest";
import {
	deviceBuildChip,
	deviceVersionLabel,
	formatElapsed,
	runnerLimitDisplay,
	runnerVersionLabel,
} from "./types";

const NOW = Date.parse("2026-06-22T08:00:00.000Z");

describe("formatElapsed", () => {
	it("returns null when no start time is known", () => {
		expect(formatElapsed(null, NOW)).toBeNull();
		expect(formatElapsed("not-a-date", NOW)).toBeNull();
	});

	it("formats sub-minute durations as seconds", () => {
		expect(formatElapsed("2026-06-22T07:59:12.000Z", NOW)).toBe("48s");
	});

	it("formats sub-hour durations as Mm Ss", () => {
		expect(formatElapsed("2026-06-22T07:56:48.000Z", NOW)).toBe("3m 12s");
	});

	it("formats multi-hour durations as Hh Mm", () => {
		expect(formatElapsed("2026-06-22T05:30:00.000Z", NOW)).toBe("2h 30m");
	});

	it("clamps a future start time to 0s rather than going negative", () => {
		expect(formatElapsed("2026-06-22T08:05:00.000Z", NOW)).toBe("0s");
	});
});

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

describe("runnerVersionLabel", () => {
	it("labels a reported version as the runner's, so it cannot read as Forge's", () => {
		expect(runnerVersionLabel("0.17.0")).toBe("Runner v0.17.0");
	});

	it("says a version was not reported rather than rendering nothing", () => {
		expect(runnerVersionLabel(null)).toBe("version not reported");
		expect(runnerVersionLabel(undefined)).toBe("version not reported");
		expect(runnerVersionLabel("   ")).toBe("version not reported");
	});
});

describe("deviceVersionLabel", () => {
	it("prefixes a reported version with v", () => {
		expect(deviceVersionLabel("0.17.0")).toBe("v0.17.0");
	});

	it("says a version was not reported rather than rendering nothing", () => {
		expect(deviceVersionLabel(null)).toBe("version not reported");
		expect(deviceVersionLabel("")).toBe("version not reported");
	});
});

describe("deviceBuildChip", () => {
	it("warns on a box that is behind, carrying the server's own sentence", () => {
		const chip = deviceBuildChip({
			agentOutdated: true,
			agentBuildState: "behind",
			agentBuildDetail: "runner 0.17.0 is behind the published 0.17.1",
		});
		expect(chip).toEqual({
			label: "update pending",
			title: "runner 0.17.0 is behind the published 0.17.1",
			tone: "warning",
		});
	});

	it("warns on a box the release itself left behind, where the box matches what was published", () => {
		const chip = deviceBuildChip({
			agentOutdated: true,
			agentBuildState: "current",
			agentBuildDetail: "runner 0.17.0 (bd2e36d5ea), but no release carries what landed",
		});
		expect(chip?.tone).toBe("warning");
	});

	// A box the health endpoint refuses must not read as a box with nothing wrong.
	it("says so when the build could not be compared, rather than showing nothing", () => {
		const chip = deviceBuildChip({
			agentOutdated: false,
			agentBuildState: "unknown",
			agentBuildDetail: "this box did not say which build it is running",
		});
		expect(chip).toEqual({
			label: "build unknown",
			title: "this box did not say which build it is running",
			tone: "muted",
		});
	});

	it("shows nothing for a box running what landed", () => {
		expect(
			deviceBuildChip({
				agentOutdated: false,
				agentBuildState: "current",
				agentBuildDetail: "runner 0.17.1 (fbe6468ddf)",
			}),
		).toBeNull();
	});

	it("still labels a chip whose sentence the server left empty", () => {
		expect(
			deviceBuildChip({ agentOutdated: true, agentBuildState: "behind", agentBuildDetail: "" })
				?.title,
		).toBe("Update pending");
		expect(
			deviceBuildChip({ agentOutdated: false, agentBuildState: "unknown", agentBuildDetail: "" })
				?.title,
		).toBe("This build could not be compared");
	});
});
