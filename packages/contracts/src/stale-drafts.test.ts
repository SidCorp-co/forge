import { describe, expect, it } from "vitest";
import {
	isStaleDraftQuestion,
	STALE_DRAFT_OPTION_IDS,
} from "./stale-drafts.js";

describe("isStaleDraftQuestion", () => {
	it("reads a round offering the drop and the keep as a merge-or-drop question", () => {
		const ids = Object.values(STALE_DRAFT_OPTION_IDS).map((id) => ({ id }));
		expect(isStaleDraftQuestion(ids)).toBe(true);
		expect(isStaleDraftQuestion(ids.slice(1))).toBe(true);
	});

	it("does not read any other round as one, an empty or absent one included", () => {
		expect(isStaleDraftQuestion([{ id: "accept" }, { id: "reject" }])).toBe(
			false,
		);
		expect(isStaleDraftQuestion([{ id: STALE_DRAFT_OPTION_IDS.drop }])).toBe(
			false,
		);
		expect(isStaleDraftQuestion([])).toBe(false);
		expect(isStaleDraftQuestion(undefined)).toBe(false);
	});
});
