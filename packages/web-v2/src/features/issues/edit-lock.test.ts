// ISS-1010 — the predicate five surfaces read. The rows that matter are the two
// that lock nothing: `queued` has dispatched no writer yet, and `failed` is what
// a DEFERRED RETRY reads as, so locking either refuses a person on an issue no
// job is touching — a refusal they have no way to tell from a bug.

import { describe, expect, it } from "vitest";
import {
	AGENT_HOLDS_EDIT,
	AGENT_HOLDS_MOVE,
	ANSWERABLE_WHILE_RUNNING,
	agentHoldsSelection,
	heldByAgent,
	heldInSelection,
} from "./edit-lock";
import type { IssueRow } from "./types";

describe("heldByAgent", () => {
	it("holds an issue a job is running", () => {
		expect(heldByAgent("in_progress", "running")).toBe(true);
	});

	it("leaves needs_info open however busy the issue is", () => {
		expect(heldByAgent("needs_info", "running")).toBe(false);
	});

	it("holds nothing while the job is only queued", () => {
		expect(heldByAgent("in_progress", "queued")).toBe(false);
	});

	// cm:guard a deferred retry's `agentStatus` IS `failed` — core's `deriveAgentStatus` falls through to the most recent terminal session when nothing is running or queued (the ISS-903 shape). This row going green is the lock refusing a person on an issue nothing is working.
	it("holds nothing on a failed session, which is what a deferred retry reads as", () => {
		expect(heldByAgent("in_progress", "failed")).toBe(false);
	});

	it("holds nothing on a completed session", () => {
		expect(heldByAgent("in_progress", "completed")).toBe(false);
	});

	it("holds nothing when no session reached the row at all", () => {
		expect(heldByAgent("in_progress", undefined)).toBe(false);
		expect(heldByAgent("in_progress", null)).toBe(false);
	});

	it("exempts needs_info and nothing else", () => {
		expect([...ANSWERABLE_WHILE_RUNNING]).toEqual(["needs_info"]);
	});
});

const row = (over: Partial<IssueRow>): IssueRow =>
	({ id: "i1", status: "in_progress", ...over }) as IssueRow;

describe("heldInSelection", () => {
	it("counts only the rows a job is running", () => {
		expect(
			heldInSelection([
				row({ agentStatus: "running" }),
				row({ agentStatus: "queued" }),
				row({ agentStatus: null }),
			]),
		).toBe(1);
	});

	it("counts no running needs_info row, since answering one is the way forward", () => {
		expect(
			heldInSelection([row({ status: "needs_info", agentStatus: "running" })]),
		).toBe(0);
	});

	it("counts nothing in an empty selection", () => {
		expect(heldInSelection([])).toBe(0);
	});
});

describe("agentHoldsSelection", () => {
	// cm:guard "one of nine" and "nine of nine" are different re-selections for the person holding the mouse, so the count is in the sentence rather than implied by it
	it("names the part of the selection that is held", () => {
		expect(agentHoldsSelection(1, 9)).toContain("1 of the 9 selected issues");
	});

	it("does not say 'n of n' when the whole selection is held", () => {
		expect(agentHoldsSelection(9, 9)).toContain("all 9 selected issues");
		expect(agentHoldsSelection(9, 9)).not.toContain("9 of the 9");
	});

	it("says 'this issue' rather than 'all 1 selected issues'", () => {
		expect(agentHoldsSelection(1, 1)).toContain("this issue");
	});
});

describe("the reasons", () => {
	// cm:guard both say WHY rather than going quiet. A control that disappears or greys out with no sentence is indistinguishable from a broken one, which is the failure the lock exists to remove and not a second copy of it.
	it("each say the edit would be overwritten", () => {
		expect(AGENT_HOLDS_MOVE).toMatch(/would be overwritten/);
		expect(AGENT_HOLDS_EDIT).toMatch(/would be overwritten/);
	});
});
