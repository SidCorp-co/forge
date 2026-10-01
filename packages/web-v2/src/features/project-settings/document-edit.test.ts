import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { documentRefusals } from "@/lib/api/refusals";
import {
	movedSince,
	nearestHeld,
	placeRefusals,
	pointerOf,
	reapply,
	REMOVE,
	segmentsOf,
	setAt,
} from "./document-edit";

const doc = { environments: { "a/b": { url: "https://x" } }, promotions: [{ from: "dev", to: "main" }] };

describe("pointers", () => {
	it("round-trips a segment holding a slash or a tilde", () => {
		expect(pointerOf(["environments", "a/b", "~x"])).toBe("/environments/a~1b/~0x");
		expect(segmentsOf("/environments/a~1b/~0x")).toEqual(["environments", "a/b", "~x"]);
		expect(segmentsOf("")).toEqual([]);
	});

	it("finds the deepest held field along a path, through arrays", () => {
		expect(nearestHeld(doc, "/environments/a~1b/url")).toBe("/environments/a~1b/url");
		expect(nearestHeld(doc, "/environments/a~1b/tier")).toBe("/environments/a~1b");
		expect(nearestHeld(doc, "/promotions/0/via")).toBe("/promotions/0");
		expect(nearestHeld(doc, "/promotions/3")).toBe("/promotions");
		expect(nearestHeld(doc, "/nothing/here")).toBe("");
	});
});

describe("refusals", () => {
	it("reads only a 422's refusals, and files STALE_BASE under no field", () => {
		const body = {
			error: {
				refusals: [
					{ code: "STALE_BASE", path: "/baseRevision", detail: "moved" },
					{ code: "UNKNOWN_KEY", path: "/environments/a~1b/colour", detail: "no" },
				],
			},
		};
		expect(documentRefusals(new ApiError(400, "bad", undefined, undefined, body))).toEqual([]);
		const refusals = documentRefusals(new ApiError(422, "x", undefined, undefined, body));
		expect(refusals).toHaveLength(2);
		const placed = placeRefusals(doc, refusals);
		expect([...placed.keys()]).toEqual(["/environments/a~1b"]);
	});
});

describe("moving and re-applying", () => {
	const read = { qa: "self", intake: { mode: "auto" } };
	it("names what another writer moved and which of it the person also edited", () => {
		const fresh = { qa: "independent", intake: { mode: "manual" } };
		const held = { qa: "self", intake: { mode: "auto" }, extra: true };
		expect(movedSince(read, fresh, { ...held, qa: "x" })).toEqual([
			{ path: "qa", read: "self", stored: "independent", contested: true },
			{ path: "intake.mode", read: "auto", stored: "manual", contested: false },
		]);
	});

	it("replays the person's edits over the stored document", () => {
		expect(reapply(read, { ...read, qa: "independent" }, { ...read, intake: { mode: "manual" } })).toEqual({
			qa: "independent",
			intake: { mode: "manual" },
		});
	});
});

describe("setAt", () => {
	it("replaces and removes without mutating, in objects and arrays", () => {
		const removed = setAt(doc, ["promotions", "0"], REMOVE) as typeof doc;
		expect(removed.promotions).toEqual([]);
		expect(doc.promotions).toHaveLength(1);
		const set = setAt(doc, ["environments", "a/b", "url"], "https://y") as typeof doc;
		expect(set.environments["a/b"].url).toBe("https://y");
		expect(doc.environments["a/b"].url).toBe("https://x");
	});
});
