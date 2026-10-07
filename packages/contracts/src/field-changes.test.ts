import { describe, expect, it } from "vitest";
import {
	convertSnapshotPayload,
	isSnapshotPayload,
	issueUpdatedAsChanges,
} from "./field-changes.js";

describe("a snapshot row read as its changes (ISS-124)", () => {
	it("walks a moved field into paths and lists a field that did not move as unchanged", () => {
		const out = convertSnapshotPayload({
			fields: ["status", "title", "ctx"],
			before: { status: "a", title: "t", ctx: { n: 1 } },
			after: { status: "b", title: "t", ctx: { n: 2 } },
		});
		expect(out).toEqual({
			fields: ["status", "ctx"],
			changes: [
				{ path: ["status"], op: "set", before: "a", after: "b" },
				{ path: ["ctx", "n"], op: "set", before: 1, after: 2 },
			],
			anchor: { status: "a", title: "t", ctx: { n: 1 } },
			unchanged: ["title"],
		});
	});

	it("reads a field listed with no before as a set carrying only its after", () => {
		const out = convertSnapshotPayload({
			fields: ["mergedAt"],
			before: {},
			after: { mergedAt: "2026-01-01T00:00:00.000Z" },
		});
		expect(out.changes).toEqual([
			{ path: ["mergedAt"], op: "set", after: "2026-01-01T00:00:00.000Z" },
		]);
		expect(out.anchor).toBeUndefined();
	});

	it("refuses a snapshot whose listed field has no after, naming the field", () => {
		expect(() =>
			convertSnapshotPayload({ fields: ["status"], before: {}, after: {} }),
		).toThrow('field "status" is listed in "fields" with no value in "after"');
	});

	it("refuses a payload that is not the snapshot object, and a converted row is not a snapshot", () => {
		expect(() => convertSnapshotPayload("x")).toThrow(
			"{fields, before, after}",
		);
		expect(() =>
			convertSnapshotPayload({ fields: "status", before: {}, after: {} }),
		).toThrow('"fields" must be an array');
		const converted = { fields: [], changes: [] };
		expect(isSnapshotPayload(converted)).toBe(false);
		expect(issueUpdatedAsChanges(converted)).toBe(converted);
	});
});
