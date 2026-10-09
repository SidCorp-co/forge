import { describe, expect, it } from "vitest";
import { articleFor, typeWithArticle, withArticle } from "./articles.js";

describe("the article a sentence writes before a value", () => {
	it("is an before a vowel sound and a before a consonant sound", () => {
		expect(["object", "issue", "image", "event", "acknowledgement", "undefined", "api_example"].map(withArticle)).toEqual([
			"an object",
			"an issue",
			"an image",
			"an event",
			"an acknowledgement",
			"an undefined",
			"an api_example",
		]);
		expect(["list", "sketch", "number", "process", "change-request"].map(withArticle)).toEqual([
			"a list",
			"a sketch",
			"a number",
			"a process",
			"a change-request",
		]);
	});

	it("follows the sound, not the letter", () => {
		expect(["unit", "user", "usual", "one", "European", "hour", "honest"].map(articleFor)).toEqual([
			"a",
			"a",
			"a",
			"a",
			"a",
			"an",
			"an",
		]);
	});

	it("reads a capitalised or vowel-less word letter by letter", () => {
		expect(["RFI", "HTML", "html", "SMS", "MCP", "UI", "BC", "PAT", "http"].map(withArticle)).toEqual([
			"an RFI",
			"an HTML",
			"an html",
			"an SMS",
			"an MCP",
			"a UI",
			"a BC",
			"a PAT",
			"an http",
		]);
	});

	it("says a number as a number", () => {
		expect(["8", "11", "18", "80", "800", "8000", "11000", "1", "7", "100", "110", "180"].map(articleFor)).toEqual(
			["an", "an", "an", "an", "an", "an", "an", "a", "a", "a", "a", "a"],
		);
	});

	it("names a value by its JavaScript type without writing 'a object'", () => {
		expect([{}, [], "x", 1, true, null, undefined, () => 0].map(typeWithArticle)).toEqual([
			"an object",
			"a list",
			"a string",
			"a number",
			"a boolean",
			"null",
			"an undefined",
			"a function",
		]);
	});
});
