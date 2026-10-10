/**
 * A title over its bound, or blank, is refused in words naming the bound, never zod's own text
 * (judge J6 on 0.4.0-dev.223: "Too big: expected string to have <=500 characters", FB-118).
 *
 * @direct-test-of packages/contracts/src/title-text.ts
 */

import { describe, expect, it } from "vitest";
import { createFeedbackRequestSchema } from "./feedback.js";
import { REQUIREMENT_TITLE_MAX, titleText } from "./title-text.js";

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
