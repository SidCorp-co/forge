import { describe, expect, it } from "vitest";
import { heldPartNotice, heldPartSchema } from "./reply-check.js";

describe("a held reply still shows the part it could check (BC-3)", () => {
	it("takes checked text with what was left out", () => {
		const r = heldPartSchema.safeParse({
			verdict: "partial",
			shown:
				"Three things need a decision from you: ISS-451, ISS-458 and ISS-465.",
			blocks: 0,
			held: [{ claim: "figure", count: 2 }],
		});
		expect(r.success).toBe(true);
	});

	it("takes blocks alone, when every clause was held but the reads drew a table", () => {
		expect(
			heldPartSchema.safeParse({
				verdict: "partial",
				shown: "",
				blocks: 1,
				held: [{ claim: "status", count: 1 }],
			}).success,
		).toBe(true);
	});

	it("refuses a partial reply that shows nothing: that is withheld, never an empty partial", () => {
		const r = heldPartSchema.safeParse({
			verdict: "partial",
			shown: "  ",
			blocks: 0,
			held: [{ claim: "figure", count: 1 }],
		});
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).toContain(
			"with neither it is withheld",
		);
	});

	it("refuses one that left nothing out, and a claim counted twice", () => {
		expect(
			heldPartSchema.safeParse({
				verdict: "partial",
				shown: "x",
				blocks: 0,
				held: [],
			}).success,
		).toBe(false);
		const twice = [
			{ claim: "figure", count: 1 },
			{ claim: "figure", count: 2 },
		];
		expect(
			heldPartSchema.safeParse({
				verdict: "partial",
				shown: "x",
				blocks: 0,
				held: twice,
			}).success,
		).toBe(false);
	});

	it("names what was left out in one line", () => {
		expect(heldPartNotice([{ claim: "figure", count: 1 }])).toBe(
			"The reply check left out a figure that nothing this answer read backs. What is shown above was checked.",
		);
		expect(
			heldPartNotice([
				{ claim: "figure", count: 2 },
				{ claim: "date", count: 1 },
				{ claim: "status", count: 3 },
			]),
		).toContain("2 figures, a date and 3 claims about where work stands");
	});
});
