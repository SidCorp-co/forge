import { describe, expect, it } from "vitest";
import { masterModeOf } from "./master-mode.js";

describe("masterModeOf: a master builds directly only where the project runs fast", () => {
	it("is direct under yolo with fast delivery on, whether fast is absent or said", () => {
		expect(masterModeOf({ gates: { profile: "yolo" } })).toBe("direct");
		expect(masterModeOf({ gates: { profile: "yolo" }, delivery: { fast: true } })).toBe("direct");
	});

	it("dispatches under yolo where fast delivery is turned off", () => {
		expect(masterModeOf({ gates: { profile: "yolo" }, delivery: { fast: false } })).toBe("dispatch");
	});

	it("dispatches under standard and strict, and with no gates or no document at all", () => {
		expect(masterModeOf({ gates: { profile: "standard" } })).toBe("dispatch");
		expect(masterModeOf({ gates: { profile: "strict" }, delivery: { fast: true } })).toBe("dispatch");
		expect(masterModeOf({})).toBe("dispatch");
		expect(masterModeOf(null)).toBe("dispatch");
	});

	it("dispatches once an incident raised a yolo project, since the raise moves its profile", () => {
		const raised = {
			profile: "standard" as const,
			raised: { from: "yolo" as const, cause: "deploy_failed" as const, ref: "r1", at: "2026-10-30T00:00:00.000Z" },
		};
		expect(masterModeOf({ gates: raised })).toBe("dispatch");
	});
});
