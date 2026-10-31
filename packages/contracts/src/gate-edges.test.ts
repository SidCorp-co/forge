import { describe, expect, it } from "vitest";
import { gatesMove, gateTargets } from "./gate-edges.js";
import { ISSUE_READY_CHECKLIST } from "./checklist-registry.js";

describe("a gate's edges", () => {
	const one = { machine: "issue", from: ["in_progress"], to: "approved" } as const;

	it("reads a single target as a list of one", () => {
		expect(gateTargets(one)).toEqual(["approved"]);
		expect(gatesMove(one, { machine: "issue", from: "in_progress", to: "approved" })).toBe(true);
		expect(gatesMove(one, { machine: "issue", from: "in_progress", to: "open" })).toBe(false);
	});

	it("gates the issue-ready checklist on both ways out of draft, and on nothing else (ISS-834)", () => {
		const gates = ISSUE_READY_CHECKLIST.gates;
		expect(gateTargets(gates)).toEqual(["open", "in_progress"]);
		for (const to of ["open", "in_progress"]) {
			expect(gatesMove(gates, { machine: "issue", from: "draft", to })).toBe(true);
		}
		expect(gatesMove(gates, { machine: "issue", from: "open", to: "in_progress" })).toBe(false);
		expect(gatesMove(gates, { machine: "issue", from: "draft", to: "dropped" })).toBe(false);
		expect(gatesMove(gates, { machine: "requirement", from: "draft", to: "open" })).toBe(false);
		expect(gatesMove(gates, { machine: "issue", from: null, to: "open" })).toBe(false);
	});
});
