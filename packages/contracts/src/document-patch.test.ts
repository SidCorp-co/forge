import { describe, expect, it } from "vitest";
import {
	applyDocumentPatch,
	buildDocumentPatch,
	canonicalJson,
	comparePatchBase,
	describeConflicts,
	patchLeafPaths,
	formatPath,
	parsePath,
	readPath,
	rebaseDocumentDraft,
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
		).toEqual([["states", "open", "deviceIds"], ["enabled"]]);
	});

	it("claims a null, which is a write", () => {
		expect(patchLeafPaths({ states: { open: { deviceIds: null } } })).toEqual([
			["states", "open", "deviceIds"],
		]);
	});

	it("claims nothing for an empty object, which writes nothing", () => {
		expect(patchLeafPaths({ states: {} })).toEqual([]);
	});
});

describe("readPath", () => {
	it("answers undefined through a missing or non-object segment", () => {
		expect(readPath({ a: { b: 1 } }, ["a", "b"])).toBe(1);
		expect(readPath({ a: { b: 1 } }, ["a", "c"])).toBeUndefined();
		expect(readPath({ a: 3 }, ["a", "b"])).toBeUndefined();
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

// A record key may legally hold a period — an MCP server named `team.prod`, a preview key a
// project invented. Joined into one string it reads as two levels of nesting, and a comparison
// that looks for it there finds `undefined` on both sides and lets a stale write through.
describe("a key that contains a period", () => {
	it("is one segment of the path, not two", () => {
		expect(
			patchLeafPaths({ mcpServers: { "team.prod": { url: "x" } } }),
		).toEqual([["mcpServers", "team.prod", "url"]]);
	});

	it("is read back off the document it names", () => {
		expect(
			readPath({ mcpServers: { "team.prod": { url: "old" } } }, [
				"mcpServers",
				"team.prod",
				"url",
			]),
		).toBe("old");
	});

	it("conflicts when the store moved under it", () => {
		const stored = { mcpServers: { "team.prod": { url: "new" } } };
		const base = { mcpServers: { "team.prod": { url: "old" } } };
		const conflicts = comparePatchBase(stored, base, {
			mcpServers: { "team.prod": { url: "mine" } },
		});
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]?.base).toBe("old");
		expect(conflicts[0]?.stored).toBe("new");
	});

	it("is quoted where the refusal prints it, so a reader can tell it from nesting", () => {
		expect(formatPath(["mcpServers", "team.prod", "url"])).toBe(
			'mcpServers."team.prod".url',
		);
		expect(formatPath(["states", "open", "deviceIds"])).toBe(
			"states.open.deviceIds",
		);
	});
});

describe("parsePath", () => {
	it("reads back every path formatPath writes", () => {
		for (const path of [
			["states", "open", "deviceIds"],
			["mcpServers", "team.prod", "url"],
			["limits"],
			["preview", "urls"],
			["mcpServers", 'he said "hi".prod'],
			["mcpServers", ""],
		]) {
			expect(parsePath(formatPath(path))).toEqual(path);
		}
	});

	it("keeps a quote that is not a quoted segment as the character it is", () => {
		expect(parsePath('a"b.c')).toEqual(['a"b', "c"]);
	});
});

// The client half of the same contract: what a person holding unsaved edits keeps when the
// document they read is read again (ISS-1170 criterion 20).
describe("rebaseDocumentDraft", () => {
	const read = {
		states: { open: { disallowedTools: ["Bash"], allowedTools: ["Read"] } },
		assistantWeekly: { pinnedIssue: "ISS-25", enabled: true },
	};

	it("keeps every edit the person made and takes the stored value everywhere else", () => {
		const held = {
			...read,
			assistantWeekly: { pinnedIssue: "ISS-9999", enabled: true },
		};
		const fresh = {
			...read,
			states: { open: { disallowedTools: ["Bash", "WebFetch"], allowedTools: ["Read"] } },
		};
		const { draft, replaced } = rebaseDocumentDraft({ read, held, fresh });
		expect(draft.assistantWeekly).toEqual({ pinnedIssue: "ISS-9999", enabled: true });
		expect(draft.states).toEqual({
			open: { disallowedTools: ["Bash", "WebFetch"], allowedTools: ["Read"] },
		});
		expect(replaced).toEqual([]);
	});

	it("keeps the person's edit at a path the store moved too, where nothing yields it", () => {
		const held = {
			...read,
			states: { open: { disallowedTools: ["Bash", "mine"], allowedTools: ["Read"] } },
		};
		const fresh = {
			...read,
			states: { open: { disallowedTools: ["Bash", "theirs"], allowedTools: ["Read"] } },
		};
		const { draft, replaced } = rebaseDocumentDraft({ read, held, fresh });
		expect(readPath(draft, ["states", "open", "disallowedTools"])).toEqual(["Bash", "mine"]);
		expect(replaced).toEqual([]);
	});

	it("takes the stored value at a yielded path, and says which edit went", () => {
		const held = {
			...read,
			states: { open: { disallowedTools: ["Bash", "mine"], allowedTools: ["Read", "Edit"] } },
			assistantWeekly: { pinnedIssue: "ISS-9999", enabled: true },
		};
		const fresh = {
			...read,
			states: { open: { disallowedTools: ["Bash", "theirs"], allowedTools: ["Read"] } },
		};
		const { draft, replaced } = rebaseDocumentDraft({
			read,
			held,
			fresh,
			yielding: [["states", "open", "disallowedTools"]],
		});
		expect(readPath(draft, ["states", "open", "disallowedTools"])).toEqual(["Bash", "theirs"]);
		// Yielding one path yields that path alone: the allowlist edit beside it stands, and so
		// does the section that was never named.
		expect(readPath(draft, ["states", "open", "allowedTools"])).toEqual(["Read", "Edit"]);
		expect(draft.assistantWeekly).toEqual({ pinnedIssue: "ISS-9999", enabled: true });
		expect(replaced).toEqual([
			{
				path: "states.open.disallowedTools",
				typed: ["Bash", "mine"],
				stored: ["Bash", "theirs"],
			},
		]);
	});

	it("reports nothing replaced where the person had typed nothing at the yielded path", () => {
		const { draft, replaced } = rebaseDocumentDraft({
			read,
			held: read,
			fresh: { ...read, assistantWeekly: { pinnedIssue: "ISS-77", enabled: true } },
			yielding: [["assistantWeekly", "pinnedIssue"]],
		});
		expect(draft.assistantWeekly).toEqual({ pinnedIssue: "ISS-77", enabled: true });
		expect(replaced).toEqual([]);
	});

	it("yields an edit made above the path named, and one made below it", () => {
		const above = rebaseDocumentDraft({
			read,
			held: { ...read, states: { open: { disallowedTools: ["mine"], allowedTools: ["Read"] } } },
			fresh: { ...read, states: { open: { disallowedTools: ["theirs"], allowedTools: ["Read"] } } },
			yielding: [["states"]],
		});
		expect(readPath(above.draft, ["states", "open", "disallowedTools"])).toEqual(["theirs"]);
		expect(above.replaced.map((r) => r.path)).toEqual(["states.open.disallowedTools"]);

		const below = rebaseDocumentDraft({
			read,
			held: { ...read, assistantWeekly: { pinnedIssue: "ISS-9999", enabled: true } },
			fresh: { ...read, assistantWeekly: { pinnedIssue: "ISS-77", enabled: true } },
			yielding: [["assistantWeekly", "pinnedIssue"]],
		});
		expect(below.draft.assistantWeekly).toEqual({ pinnedIssue: "ISS-77", enabled: true });
		expect(below.replaced.map((r) => r.path)).toEqual(["assistantWeekly.pinnedIssue"]);
	});

	it("carries a deletion the person made, and takes a key the store added", () => {
		const { draft } = rebaseDocumentDraft({
			read,
			held: { states: read.states },
			fresh: { ...read, intakeGate: { enabled: true } },
		});
		expect(draft).not.toHaveProperty("assistantWeekly");
		expect(draft.intakeGate).toEqual({ enabled: true });
	});

	it("takes the fresh document whole where the person changed nothing", () => {
		const fresh = { ...read, enabled: false };
		expect(rebaseDocumentDraft({ read, held: read, fresh }).draft).toEqual(fresh);
	});

	it("keeps an edit at a key whose name contains a period", () => {
		const base = { mcpServers: { "team.prod": { url: "old" } } };
		const { draft, replaced } = rebaseDocumentDraft({
			read: base,
			held: { mcpServers: { "team.prod": { url: "mine" } } },
			fresh: { mcpServers: { "team.prod": { url: "theirs" } } },
			yielding: [["mcpServers", "team.prod", "url"]],
		});
		expect(readPath(draft, ["mcpServers", "team.prod", "url"])).toBe("theirs");
		expect(replaced[0]?.path).toBe('mcpServers."team.prod".url');
	});
});
