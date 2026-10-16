/**
 * A title over its bound, or blank, is refused in words naming the bound, never zod's own text
 * (judge J6 on 0.4.0-dev.223: "Too big: expected string to have <=500 characters", FB-118).
 *
 * @direct-test-of packages/contracts/src/title-text.ts
 */

import { describe, expect, it } from "vitest";
import { createFeedbackRequestSchema } from "./feedback.js";
import { cutAtWord, REQUIREMENT_TITLE_MAX, shortForm, titleText } from "./title-text.js";

const messageOf = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues[0]?.message;

describe("a title field", () => {
	it("takes a title at its bound, trimmed", () => {
		expect(titleText(REQUIREMENT_TITLE_MAX).parse(` ${"a".repeat(500)} `)).toHaveLength(500);
	});

	it("refuses one over its bound in plain words naming the bound", () => {
		const said = messageOf(titleText(REQUIREMENT_TITLE_MAX).safeParse("a".repeat(501)));
		expect(said).toBe("The title is longer than 500 characters: shorten it to 500 or fewer.");
	});

	it("refuses a blank one in plain words", () => {
		expect(messageOf(titleText(10).safeParse("   "))).toBe("The title is blank: say in a few words what this is.");
	});

	it("is the feedback create's title, so its refusal is never zod's own text", () => {
		const r = createFeedbackRequestSchema.safeParse({ kind: "bug", title: "x".repeat(301), screen: "Home" });
		expect(r.success).toBe(false);
		const said = r.error?.issues.find((i) => i.path[0] === "title")?.message;
		expect(said).toBe("The title is longer than 300 characters: shorten it to 300 or fewer.");
		expect(said).not.toMatch(/Too big|expected/);
	});
});

describe("a text cut for a list row", () => {
	const source = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");

	it("keeps a text within its bound whole, on one line", () => {
		expect(cutAtWord("  The case\n reaches   its owner ", 500)).toBe("The case reaches its owner");
	});

	it("cuts one past its bound at the last whole word that fits, with an ellipsis, within the bound", () => {
		const cut = cutAtWord(source, 500);
		expect(cut.length).toBeLessThanOrEqual(500);
		expect(cut.endsWith("…")).toBe(true);
		const kept = cut.slice(0, -1);
		expect(source.startsWith(kept)).toBe(true);
		expect(source.charAt(kept.length)).toBe(" ");
	});

	it("keeps a word that ends exactly one short of the bound", () => {
		expect(cutAtWord("abcd efgh", 6)).toBe("abcd…");
		expect(cutAtWord("abc defgh", 5)).toBe("abc…");
	});

	it("cuts inside a first word longer than the bound, the one text with no boundary", () => {
		expect(cutAtWord("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
	});

	it("reads a comment's short form as its first sentence of its first line that says anything", () => {
		expect(shortForm("\n\nIs the export blocked? I tried twice.\nMore below.", 200)).toBe("Is the export blocked?");
		expect(shortForm("## Requirement\n\nREQ-4 says so.", 200)).toBe("## Requirement");
		expect(shortForm("v1.2 ships the fix today", 200)).toBe("v1.2 ships the fix today");
		expect(shortForm(`${source}. Second sentence.`, 120).length).toBeLessThanOrEqual(120);
	});
});
