import { describe, expect, it } from "vitest";
import { masterModeOf } from "./master-mode.js";

describe("masterModeOf: a master builds directly wherever the project runs fast and is not strict", () => {
	it("is direct under yolo with fast delivery on, whether fast is absent or said", () => {
		expect(masterModeOf({ gates: { profile: "yolo" } })).toBe("direct");
		expect(masterModeOf({ gates: { profile: "yolo" }, delivery: { fast: true } })).toBe("direct");
	});

	it("dispatches under yolo where fast delivery is turned off", () => {
		expect(masterModeOf({ gates: { profile: "yolo" }, delivery: { fast: false } })).toBe("dispatch");
	});

	// REQ-79 r6 (owner ruling 2026-10-31): agents act first unless the project asks for human control
	it("is direct under standard and with no gates or no document, where fast delivery is on", () => {
		expect(masterModeOf({ gates: { profile: "standard" } })).toBe("direct");
		expect(masterModeOf({})).toBe("direct");
		expect(masterModeOf(null)).toBe("direct");
		expect(masterModeOf({ gates: { profile: "standard" }, delivery: { fast: false } })).toBe("dispatch");
	});

	it("dispatches under strict, the human control a project asks for, fast or not", () => {
		expect(masterModeOf({ gates: { profile: "strict" }, delivery: { fast: true } })).toBe("dispatch");
		expect(masterModeOf({ gates: { profile: "strict" } })).toBe("dispatch");
	});
});
