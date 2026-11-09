import { describe, expect, it } from "vitest";
import { criterionShortTitle, criterionTitleFault } from "./criterion-title.js";

describe("a criterion's short title (ISS-1131)", () => {
	it("refuses a title over eight words, keeps one of eight", () => {
		expect(
			criterionTitleFault("one two three four five six seven eight"),
		).toBeNull();
		expect(
			criterionTitleFault("one two three four five six seven eight nine"),
		).toMatch(/at most 8 words; .* has 9/);
		expect(criterionTitleFault(null)).toBeNull();
	});

	it("shows the title where there is one, and says the sentence holds more", () => {
		expect(
			criterionShortTitle({
				title: "Each fact once",
				text: "The review page shows each fact once.",
			}),
		).toEqual({ short: "Each fact once", cut: true });
	});

	it("shows the first clause where there is none, whole when the sentence is one clause", () => {
		expect(criterionShortTitle({ text: "A person signs in." })).toEqual({
			short: "A person signs in.",
			cut: false,
		});
		expect(
			criterionShortTitle({
				text: "The review page shows each fact once, and opens the rest on demand.",
			}),
		).toEqual({
			short: "The review page shows each fact once",
			cut: true,
		});
	});

	it("cuts a long clause at a word boundary, never inside a word", () => {
		const text =
			"Every screen of the workspace shows a name a status and one next act without explaining copy";
		const { short, cut } = criterionShortTitle({ text });
		expect(cut).toBe(true);
		expect(short.endsWith("…")).toBe(true);
		const shown = short.slice(0, -1).split(" ");
		expect(shown.length).toBeLessThanOrEqual(10);
		for (const w of shown) expect(text.split(" ")).toContain(w);
	});

	// REQ-12 BC-12 on forge-dev, 2026-11-09: a row read "Dependency direction
	// (scripts/lib/module-boundaries.mjs:MAY_IMPORT)" (ISS-1179 item 8)
	it("leaves a code anchor in brackets out of the row's face, the sentence keeping it", () => {
		expect(
			criterionShortTitle({
				text: "Dependency direction (scripts/lib/module-boundaries.mjs:MAY_IMPORT): door imports door, read-model, domain.",
			}),
		).toEqual({ short: "Dependency direction", cut: true });
		// a bracket of plain words is the criterion's own, and stays
		expect(
			criterionShortTitle({ text: "Owners (and their deputies) sign off." }),
		).toEqual({ short: "Owners (and their deputies) sign off.", cut: false });
	});
});
