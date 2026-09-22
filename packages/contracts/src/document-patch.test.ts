import { describe, expect, it } from "vitest";
import {
	applyDocumentPatch,
	buildDocumentPatch,
	canonicalJson,
	comparePatchBase,
	describeConflicts,
	patchLeafPaths,
	readPath,
	sameStoredValue,
} from "./document-patch.js";

describe("applyDocumentPatch", () => {
	it("leaves a key the patch does not name untouched at every depth", () => {
		const stored = {
			states: {
				open: { deviceIds: ["d1"], allowedTools: ["Read"] },
				in_progress: { enabled: true },
			},
			legacyKeyNoSchemaSurfaces: { kept: 1 },
		};
		const next = applyDocumentPatch(stored, {
			states: { open: { deviceIds: ["d2"] } },
		});
		expect(next).toEqual({
			states: {
				open: { deviceIds: ["d2"], allowedTools: ["Read"] },
				in_progress: { enabled: true },
			},
			legacyKeyNoSchemaSurfaces: { kept: 1 },
		});
	});

	it("deletes the key a patch sets to null and leaves its siblings", () => {
		const next = applyDocumentPatch(
			{ states: { open: { deviceIds: ["d1"], allowedTools: ["Read"] } } },
			{ states: { open: { deviceIds: null } } },
		);
		expect(next).toEqual({ states: { open: { allowedTools: ["Read"] } } });
	});

	it("replaces an array rather than merging it", () => {
		expect(applyDocumentPatch({ tools: ["a", "b"] }, { tools: ["c"] })).toEqual(
			{ tools: ["c"] },
		);
	});

	it("creates a nested object the document does not have yet", () => {
		expect(
			applyDocumentPatch({}, { states: { open: { enabled: true } } }),
		).toEqual({
			states: { open: { enabled: true } },
		});
	});

	it("does not mutate the document it was given", () => {
		const stored = { a: { b: 1 } };
		applyDocumentPatch(stored, { a: { b: 2 } });
		expect(stored).toEqual({ a: { b: 1 } });
	});
});

describe("patchLeafPaths", () => {
	it("walks a nested object rather than claiming it", () => {
		expect(
			patchLeafPaths({
				states: { open: { deviceIds: ["d1"] } },
				enabled: true,
			}),
		).toEqual(["states.open.deviceIds", "enabled"]);
	});

	it("claims a null, which is a write", () => {
		expect(patchLeafPaths({ states: { open: { deviceIds: null } } })).toEqual([
			"states.open.deviceIds",
		]);
	});

	it("claims nothing for an empty object, which writes nothing", () => {
		expect(patchLeafPaths({ states: {} })).toEqual([]);
	});
});

describe("readPath", () => {
	it("answers undefined through a missing or non-object segment", () => {
		expect(readPath({ a: { b: 1 } }, "a.b")).toBe(1);
		expect(readPath({ a: { b: 1 } }, "a.c")).toBeUndefined();
		expect(readPath({ a: 3 }, "a.b")).toBeUndefined();
	});
});

describe("comparePatchBase", () => {
	const stored = {
		states: { open: { deviceIds: ["d1"], allowedTools: ["Read"] } },
	};

	it("finds nothing where the caller read what is stored", () => {
		expect(
			comparePatchBase(stored, stored, {
				states: { open: { deviceIds: ["d2"] } },
			}),
		).toEqual([]);
	});

	it("finds nothing where another path moved under the caller", () => {
		const moved = {
			states: { open: { deviceIds: ["d1"], allowedTools: ["Write"] } },
		};
		expect(
			comparePatchBase(moved, stored, {
				states: { open: { deviceIds: ["d2"] } },
			}),
		).toEqual([]);
	});

	it("names the path, what was read and what is stored", () => {
		const moved = {
			states: { open: { deviceIds: ["dX"], allowedTools: ["Read"] } },
		};
		const conflicts = comparePatchBase(moved, stored, {
			states: { open: { deviceIds: ["d2"] } },
		});
		expect(conflicts).toEqual([
			{ path: "states.open.deviceIds", base: ["d1"], stored: ["dX"] },
		]);
		expect(describeConflicts(conflicts)).toBe(
			'states.open.deviceIds: you read ["d1"], it now holds ["dX"]',
		);
	});

	it("refuses a delete of a value that moved", () => {
		const moved = { states: { open: { deviceIds: ["dX"] } } };
		expect(
			comparePatchBase(moved, stored, {
				states: { open: { deviceIds: null } },
			}),
		).toHaveLength(1);
	});

	it("refuses a creation where somebody else got there first", () => {
		const conflicts = comparePatchBase(
			{ intakeGate: { enabled: true } },
			{},
			{
				intakeGate: { enabled: false },
			},
		);
		expect(conflicts).toEqual([
			{ path: "intakeGate.enabled", base: undefined, stored: true },
		]);
	});

	it("reads an absent key and a stored null as the same value", () => {
		expect(sameStoredValue(null, undefined)).toBe(true);
		expect(
			comparePatchBase(
				{ live: {} },
				{ live: { url: null } },
				{ live: { url: "x" } },
			),
		).toEqual([]);
	});
});

describe("buildDocumentPatch", () => {
	it("sends only what changed", () => {
		const before = { live: { url: "a", apiUrl: "b" }, limits: "none" };
		const after = { live: { url: "c", apiUrl: "b" }, limits: "none" };
		expect(buildDocumentPatch(before, after)).toEqual({
			patch: { live: { url: "c" } },
			base: before,
		});
	});

	it("sends a null for a key the caller dropped", () => {
		expect(buildDocumentPatch({ a: 1, b: 2 }, { a: 1 }).patch).toEqual({
			b: null,
		});
	});

	it("sends nothing where a key went from absent to null, which the store reads alike", () => {
		expect(
			buildDocumentPatch({ live: {} }, { live: { url: null } }).patch,
		).toEqual({});
	});

	it("sends an empty patch where nothing moved", () => {
		const doc = { states: { open: { deviceIds: ["d1"] } } };
		expect(buildDocumentPatch(doc, structuredClone(doc)).patch).toEqual({});
	});
});

describe("canonicalJson", () => {
	it("renders two structurally equal documents the same", () => {
		expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(
			canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }),
		);
	});

	it("keeps array order, which is a value and not a set", () => {
		expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
	});
});
