import { describe, expect, it } from "vitest";
import { type DeviceGate, deviceGateBanner } from "./types";

const NOW = Date.parse("2026-09-24T12:00:00Z");

const gate = (over: Partial<DeviceGate> = {}): DeviceGate => ({
	verdict: "failing_open",
	count: 279,
	trimmed: true,
	perDay: 73.8,
	windowMs: 326_670_000,
	sinceLastMs: 240_000,
	byReason: [{ reason: "this pane carries no control capability", count: 279 }],
	receivedAt: "2026-09-24T11:59:00Z",
	...over,
});

describe("deviceGateBanner", () => {
	it("names the count, the rate and the window for a gate failing open", () => {
		const banner = deviceGateBanner(gate(), NOW);
		expect(banner).toMatchObject({ count: 279, rate: "74/day", window: "4d" });
	});

	it("says when one reason accounts for the whole count", () => {
		expect(deviceGateBanner(gate(), NOW)?.reason).toBe(
			"every one of them: this pane carries no control capability",
		);
	});

	it("names the commonest reason with its share where the count is a mixture", () => {
		const banner = deviceGateBanner(
			gate({
				byReason: [
					{ reason: "no control capability", count: 200 },
					{ reason: "the daemon did not answer", count: 79 },
				],
			}),
			NOW,
		);
		expect(banner?.reason).toBe("200 of 279: no control capability");
	});

	it("shows nothing for a box whose gate has never failed open", () => {
		expect(deviceGateBanner(null, NOW)).toBeNull();
		expect(deviceGateBanner(gate({ verdict: "clear" }), NOW)).toBeNull();
		expect(deviceGateBanner(gate({ verdict: "marked" }), NOW)).toBeNull();
	});

	// A box that stopped heartbeating leaves its last report standing. Reading
	// it as the present condition would rebuild the defect this reports.
	it("says how old a report is once it is no longer the box's present condition", () => {
		const banner = deviceGateBanner(gate({ receivedAt: "2026-09-21T12:00:00Z" }), NOW);
		expect(banner?.stale).toContain("3d ago");
	});

	it("says nothing about age while the report is fresh", () => {
		expect(deviceGateBanner(gate(), NOW)?.stale).toBeNull();
	});

	it("does not invent an age from a timestamp it cannot read", () => {
		expect(deviceGateBanner(gate({ receivedAt: "" }), NOW)?.stale).toBeNull();
	});

	// The box sorts its breakdown and nothing between there and here says so, so
	// the banner takes the largest count rather than whichever row arrived first.
	it("names the commonest reason even where the rows arrive out of order", () => {
		const banner = deviceGateBanner(
			gate({
				count: 279,
				byReason: [
					{ reason: "minor", count: 79 },
					{ reason: "dominant", count: 200 },
				],
			}),
			NOW,
		);
		expect(banner?.reason).toBe("200 of 279: dominant");
	});
});
