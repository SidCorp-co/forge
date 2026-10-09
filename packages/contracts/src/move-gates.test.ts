import { describe, expect, it } from "vitest";
import { ISSUE_MACHINE } from "./issue-machine.js";
import {
	birthStanding,
	countsAsPassed,
	defineMoveChecks,
	edgeGates,
	GATES,
	passedMoveStanding,
	refusingGate,
} from "./move-gates.js";
import type { MachineEdge } from "./state-machine.js";

const edge = (from: string, to: string, recovery = false): MachineEdge => {
	const found = ISSUE_MACHINE.edges.find(
		(e) => e.from === from && e.to === to && (e.recovery === true) === recovery,
	);
	if (!found) throw new Error(`no issue edge ${from} → ${to}`);
	return found;
};

describe("the gates a move asks", () => {
	it("are every registered checklist and each declared move check", () => {
		const ids = GATES.map((g) => [g.id, g.kind]);
		expect(ids).toContainEqual(["issue_ready", "checklist"]);
		expect(ids).toContainEqual(["design_record", "check"]);
		expect(ids).toContainEqual(["patterns", "check"]);
	});

	it("are read off the edge: its checklist, or the check bound to one of its guards", () => {
		const ids = (from: string, to: string, recovery = false) =>
			edgeGates("issue", edge(from, to, recovery)).map((g) => g.id);
		expect(ids("draft", "open")).toEqual(["issue_ready"]);
		expect(ids("in_progress", "approved")).toEqual(["design_record"]);
		expect(ids("in_progress", "awaiting_release")).toEqual(["patterns"]);
		expect(ids("open", "in_progress")).toEqual([]);
		// the recovery edge joins the same statuses and asks no gate
		expect(ids("in_progress", "approved", true)).toEqual([]);
	});

	it("attribute a refusal to the gate that refused it, and to none for any other guard", () => {
		const gate = (from: string, to: string, guard: string, code: string) =>
			refusingGate("issue", edge(from, to), guard, code)?.id ?? null;
		expect(gate("draft", "open", "checklist", "CHECKLIST_INCOMPLETE")).toBe("issue_ready");
		expect(gate("draft", "open", "admit", "PERMISSION_FORBIDDEN")).toBeNull();
		expect(gate("in_progress", "approved", "design", "DESIGN_RECORD_MISSING")).toBe("design_record");
		expect(gate("in_progress", "approved", "plan_checkpoint", "PLAN_REQUIRED")).toBeNull();
		expect(gate("in_progress", "awaiting_release", "merged", "PATTERN_ENTRY_MISSING")).toBe("patterns");
		expect(gate("in_progress", "awaiting_release", "merged", "MERGE_NOT_RECORDED")).toBeNull();
		// a pattern code on an edge the check does not gate is no gate's
		expect(gate("awaiting_release", "closed", "merged", "PATTERN_RETURNED")).toBeNull();
	});

	it("refuse at load a check naming an edge or a guard its machine does not have", () => {
		const check = {
			id: "x_check",
			title: "X",
			version: 1,
			gates: { machine: "issue", from: ["in_progress"], to: "approved" },
			guard: "design",
			codes: ["X"],
		} as const;
		expect(() => defineMoveChecks([check])).not.toThrow();
		expect(() => defineMoveChecks([{ ...check, gates: { ...check.gates, from: ["draft"] } }])).toThrow(
			"issue `draft` → `approved` is not an edge of its machine",
		);
		expect(() => defineMoveChecks([{ ...check, guard: "holder" }])).toThrow(
			"does not name guard `holder`",
		);
		expect(() => defineMoveChecks([{ ...check, id: "issue_ready" }])).toThrow("already a checklist's");
		expect(() => defineMoveChecks([{ ...check, codes: [] }])).toThrow("names no refusal code");
	});
});

describe("a gated move's standing", () => {
	const gate = { id: "design_record" };

	it("passes where the kernel recorded the gate judging it", () => {
		expect(passedMoveStanding(gate, { checklist: null, gates: ["design_record"] })).toBe("passed");
		expect(passedMoveStanding({ id: "issue_ready" }, { checklist: "issue_ready", gates: null })).toBe(
			"passed",
		);
	});

	it("reads a move recorded before the gate as no checklist, never counted as passing (BC-9)", () => {
		const before = passedMoveStanding(gate, { checklist: null, gates: null });
		expect(before).toBe("no_checklist");
		expect(countsAsPassed(before ?? "passed")).toBe(false);
	});

	it("is no move of the gate where the edge taken did not ask it", () => {
		expect(passedMoveStanding(gate, { checklist: null, gates: [] })).toBeNull();
	});

	it("reads a birth at the gate's status as an exception once the gate has judged a move", () => {
		const since = new Date("2026-10-09T00:00:00Z");
		expect(birthStanding(new Date("2026-10-09T00:00:01Z"), since)).toBe("exception");
		expect(birthStanding(new Date("2026-10-08T23:59:59Z"), since)).toBe("no_checklist");
		expect(birthStanding(new Date("2026-10-09T00:00:01Z"), null)).toBe("no_checklist");
		expect(countsAsPassed("exception")).toBe(false);
		expect(countsAsPassed("refused")).toBe(false);
	});
});
