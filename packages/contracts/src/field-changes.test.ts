import { describe, expect, it } from "vitest";
import {
	applyFieldChanges,
	diffFieldValue,
	FieldChangeIrreversible,
	formatFieldPath,
	issueUpdatedPayload,
} from "./field-changes.js";

const lease = (renewedAt: string, history: unknown[]) => ({
	lease: { holder: "iss-1-abc", renewedAt, history },
	worklog: { head: "9d2e6d1", notes: "x".repeat(4000) },
});

describe("issueUpdatedPayload", () => {
	it("records only the fields whose value moved", () => {
		const payload = issueUpdatedPayload(
			["title", "priority"],
			{ title: "a", priority: "high" },
			{ title: "b", priority: "high" },
		);
		expect(payload).toEqual({
			fields: ["title"],
			changes: [{ path: ["title"], op: "set", before: "a", after: "b" }],
		});
	});

	it("records a document field as the keys that changed, not the document", () => {
		const before = lease("2026-10-02T15:19:10Z", [{ how: "claim" }]);
		const after = lease("2026-10-02T15:19:26Z", [
			{ how: "claim" },
			{ how: "write" },
		]);
		const payload = issueUpdatedPayload(
			["sessionContext"],
			{ sessionContext: before },
			{ sessionContext: after },
		);
		expect(payload?.changes).toEqual([
			{
				path: ["sessionContext", "lease", "history", 1],
				op: "add",
				after: { how: "write" },
			},
			{
				path: ["sessionContext", "lease", "renewedAt"],
				op: "set",
				before: "2026-10-02T15:19:10Z",
				after: "2026-10-02T15:19:26Z",
			},
		]);
		expect(JSON.stringify(payload)).not.toContain("xxxx");
	});

	it("records a key that appears and one that goes", () => {
		expect(
			diffFieldValue("metadata", { a: 1, gone: true }, { a: 1, fresh: [1] }),
		).toEqual([
			{ path: ["metadata", "fresh"], op: "add", after: [1] },
			{ path: ["metadata", "gone"], op: "remove", before: true },
		]);
	});

	it("records nothing for a write that changes nothing, a re-sent document included", () => {
		const doc = lease("t", [{ how: "claim" }]);
		expect(
			issueUpdatedPayload(
				["sessionContext", "title"],
				{ sessionContext: doc, title: "same" },
				{ sessionContext: structuredClone(doc), title: "same" },
			),
		).toBeNull();
	});

	it("reads a Date as the ISO string it is stored as, so an unchanged timestamp is no change", () => {
		const at = new Date("2026-10-03T00:00:00Z");
		expect(diffFieldValue("mergedAt", at, at.toISOString())).toEqual([]);
		expect(diffFieldValue("mergedAt", null, at)).toEqual([
			{ path: ["mergedAt"], op: "set", before: null, after: at.toISOString() },
		]);
	});

	it("records a whole value where the shape changes (object to array, null to object)", () => {
		expect(diffFieldValue("plan", null, { steps: [] })).toEqual([
			{ path: ["plan"], op: "set", before: null, after: { steps: [] } },
		]);
		expect(diffFieldValue("x", { a: 1 }, [1])).toEqual([
			{ path: ["x"], op: "set", before: { a: 1 }, after: [1] },
		]);
	});
});

describe("applyFieldChanges", () => {
	const cases: Array<[string, unknown, unknown]> = [
		["grows an array", { h: [1, 2] }, { h: [1, 2, 3, 4] }],
		["shrinks an array", { h: [1, 2, 3, 4] }, { h: [1] }],
		[
			"nested replace and delete",
			{ a: { b: 1, c: { d: 2 } }, z: 0 },
			{ a: { b: 2 }, y: [null] },
		],
		["scalar to document", "text", { a: 1 }],
		[
			"array of documents edited in place",
			[{ k: 1 }, { k: 2 }],
			[{ k: 1 }, { k: 3, n: true }],
		],
	];

	for (const [name, before, after] of cases) {
		it(`round-trips both directions: ${name}`, () => {
			const changes = diffFieldValue("f", before, after);
			expect(applyFieldChanges("f", before, changes, "forward")).toEqual(after);
			expect(applyFieldChanges("f", after, changes, "backward")).toEqual(
				before,
			);
		});
	}

	it("refuses by name to walk back over a change that recorded no before", () => {
		const changes = [
			{
				path: ["mergedCommitSha"] as ["mergedCommitSha"],
				op: "set" as const,
				after: "abc",
			},
		];
		expect(applyFieldChanges("mergedCommitSha", null, changes, "forward")).toBe(
			"abc",
		);
		expect(() =>
			applyFieldChanges("mergedCommitSha", "abc", changes, "backward"),
		).toThrow(FieldChangeIrreversible);
	});
});

describe("formatFieldPath", () => {
	it("reads keys dotted and indices bracketed", () => {
		expect(
			formatFieldPath(["sessionContext", "lease", "history", 3, "at"]),
		).toBe("sessionContext.lease.history[3].at");
	});
});
