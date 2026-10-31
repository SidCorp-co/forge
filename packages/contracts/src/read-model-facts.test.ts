import { describe, expect, it } from "vitest";
import { isDispatchStalled } from "./agent-sessions.js";
import { inActiveOrg } from "./org-scope.js";
import { specChangesOf } from "./requirements.js";

const side = (revision: number, spec = {}, kind: null = null, criteria: { code: string; body: string }[] = []) => ({
	revision,
	spec,
	kind,
	criteria,
});

describe("isDispatchStalled", () => {
	it("stalls only when work waits and no runner is online", () => {
		expect(isDispatchStalled(2, 0)).toBe(true);
		expect(isDispatchStalled(2, 1)).toBe(false);
		expect(isDispatchStalled(0, 0)).toBe(false);
	});
});

describe("inActiveOrg", () => {
	it("shows a project under its org, under no scope, and when the caller is no member of its org", () => {
		expect(inActiveOrg({ orgId: "a", orgRole: "owner" }, "a")).toBe(true);
		expect(inActiveOrg({ orgId: "a", orgRole: "owner" }, null)).toBe(true);
		expect(inActiveOrg({ orgId: "a", orgRole: null }, "b")).toBe(true);
		expect(inActiveOrg({ orgId: "a", orgRole: "member" }, "b")).toBe(false);
	});
});

describe("specChangesOf", () => {
	it("names what a revision added and removed against its base, field by field", () => {
		const base = side(1, { goal: "old", personas: ["a", "b"], scopeIn: ["x"] }, null, [
			{ code: "BC-1", body: "one" },
			{ code: "BC-2", body: "two" },
		]);
		const next = side(2, { goal: "new", personas: ["b", "c"], scopeIn: ["x"] }, null, [
			{ code: "BC-1", body: "one" },
			{ code: "BC-2", body: "two!" },
			{ code: "BC-10", body: "ten" },
		]);
		expect(specChangesOf(base, next)).toEqual({
			against: 1,
			goal: { before: "old", after: "new" },
			kind: null,
			personas: { kept: ["b"], added: ["c"], removed: ["a"] },
			scopeIn: null,
			scopeOut: null,
			criteria: [
				{ code: "BC-2", was: "two", now: "two!" },
				{ code: "BC-10", was: null, now: "ten" },
			],
		});
	});

	it("reads a missing base as an empty spec, and an unchanged revision as no change", () => {
		expect(specChangesOf(null, side(1, { goal: "g" })).goal).toEqual({ before: null, after: "g" });
		const same = side(1, { goal: "g" }, null, [{ code: "BC-1", body: "one" }]);
		expect(specChangesOf(same, { ...same, revision: 2 })).toEqual({
			against: 1,
			goal: null,
			kind: null,
			personas: null,
			scopeIn: null,
			scopeOut: null,
			criteria: [],
		});
	});
});
