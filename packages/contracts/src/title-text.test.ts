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
		expect(shortForm("## Requirement\n\nREQ-4 says so.", 200)).toBe("Requirement");
		expect(shortForm("v1.2 ships the fix today", 200)).toBe("v1.2 ships the fix today");
		expect(shortForm(`${source}. Second sentence.`, 120).length).toBeLessThanOrEqual(120);
	});
});

// Live dev.251's Questions page: 566 rows, almost all release records, listed as `**Release…**` and
// `## Release…` with their markers raw. A short form is what the row reads, so it reads as words.
describe("a short form reads as plain words, never markdown markers", () => {
	const short = (text: string) => shortForm(text, 200);

	it("drops a heading's hashes, and a closing run of them", () => {
		expect(short("## Release 0.4.0-dev.251\n\nShipped to beta.")).toBe("Release 0.4.0-dev.251");
		expect(short("# Release notes #")).toBe("Release notes");
	});

	it("drops emphasis markers: ** __ * _ and ~~", () => {
		expect(short("**Release 0.4.0-dev.251** landed on beta. Thanks.")).toBe("Release 0.4.0-dev.251 landed on beta.");
		expect(short("__Bold__ and *slanted* and _also_ and ~~gone~~ words")).toBe("Bold and slanted and also and gone words");
		expect(short("***Both*** at once")).toBe("Both at once");
		expect(short("**run `pnpm verify` before** you push")).toBe("run pnpm verify before you push");
	});

	it("keeps inline code's text without its backticks, its own markers untouched", () => {
		expect(short("Run `pnpm verify` first.")).toBe("Run pnpm verify first.");
		expect(short("Set ``a`b`` and `*not em*` here")).toBe("Set a`b and *not em* here");
	});

	it("reads a link or an image as its text, and an autolink as its address", () => {
		expect(short("See [the release page](https://forge.example/r/251.html) now. Then more.")).toBe("See the release page now.");
		expect(short("![the board](https://forge.example/b.png) as shipped")).toBe("the board as shipped");
		expect(short("Mirrored at <https://forge.example/r/251>")).toBe("Mirrored at https://forge.example/r/251");
	});

	it("drops a list bullet, a number, a task box and a blockquote marker", () => {
		expect(short("- first bullet item")).toBe("first bullet item");
		expect(short("* star bullet")).toBe("star bullet");
		expect(short("+ plus bullet")).toBe("plus bullet");
		expect(short("12. numbered item")).toBe("numbered item");
		expect(short("- [x] done item")).toBe("done item");
		expect(short("> quoted line")).toBe("quoted line");
		expect(short("> > ## Heading in a quote")).toBe("Heading in a quote");
	});

	it("collapses whitespace to single spaces", () => {
		expect(short("  **Release**\t\t  landed   on   beta  ")).toBe("Release landed on beta");
	});

	it("skips a line that is only markup: a fence and what it holds, a rule, an empty heading", () => {
		expect(short("```ts\nconst x = 1;\n```\nThe sentence after.")).toBe("The sentence after.");
		expect(short("---\n\nAfter the rule.")).toBe("After the rule.");
		expect(short("##\n**Release** after.")).toBe("Release after.");
	});

	it("keeps a literal * or _ that is not emphasis, and an escaped marker as its character", () => {
		expect(short("rename snake_case_name to camelCase")).toBe("rename snake_case_name to camelCase");
		expect(short("2 * 3 = 6 and a * b * c")).toBe("2 * 3 = 6 and a * b * c");
		expect(short("file_name_v2.ts and __dunder_like names")).toBe("file_name_v2.ts and __dunder_like names");
		expect(short("a \\*literal\\* star")).toBe("a *literal* star");
	});
});
