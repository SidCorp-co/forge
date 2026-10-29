/**
 * A reason a reader cannot see is no reason (ISS-645, REQ-4 BC-16): text made only of spaces,
 * zero-width or format characters reads blank, whatever `trim()` leaves of it.
 *
 * @direct-test-of packages/contracts/src/reason-text.ts
 */

import { describe, expect, it } from "vitest";
import { hasVisibleText } from "./reason-text.js";

/** Text built from code points, so no character the test is about is ever written into its source. */
const cp = (...points: number[]) => String.fromCodePoint(...points);

describe("hasVisibleText", () => {
	it.each([
		["nothing", undefined],
		["null", null],
		["an empty string", ""],
		["spaces, tabs and newlines", " \t\n "],
		["a zero-width space", cp(0x200b)],
		[
			"zero-width joiners, a BOM and a word joiner",
			cp(0x200c, 0x200d, 0xfeff, 0x2060),
		],
		["a no-break and an ideographic space", cp(0xa0, 0x3000)],
		["a soft hyphen and bidi marks", cp(0xad, 0x200e, 0x202a, 0x2066)],
		["a Hangul filler", cp(0x3164)],
		["the blank Braille pattern", cp(0x2800)],
		["a lone combining mark", cp(0x301)],
	])("reads %s as blank", (_label, text) => {
		expect(hasVisibleText(text)).toBe(false);
	});

	it.each([
		["a word", "BA review"],
		["a word wrapped in zero-width spaces", `${cp(0x200b)}ok${cp(0x200b)}`],
		["a digit", "7"],
		["a punctuation mark", "?"],
		["a symbol", "✓"],
		["a non-Latin word", "đồng ý"],
		["a CJK character", "可"],
	])("reads %s as said", (_label, text) => {
		expect(hasVisibleText(text)).toBe(true);
	});
});
