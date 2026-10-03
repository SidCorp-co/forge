import { describe, expect, it } from "vitest";
import {
	CONTENT_LANGUAGE_DEFAULT,
	contentLanguageName,
	contentLanguageOf,
	contentLanguageProblem,
	contentLanguageWriteSchema,
} from "./content-language";

describe("contentLanguageProblem", () => {
	it.each(["en", "vi", "pt-BR", "zh-Hant-TW", "es-419", "sl-rozaj"])(
		"takes the canonical tag %s",
		(tag) => {
			expect(contentLanguageProblem(tag)).toBeNull();
		},
	);

	it.each([
		"",
		"vietnamese",
		"v",
		"en_US",
		"en-",
		"-en",
		"x-klingon",
		"en-US-u-ca-gregory",
		"tiếng việt",
	])("refuses %j as not a tag", (tag) => {
		expect(contentLanguageProblem(tag)).toMatch(/is not a BCP-47 language tag/);
	});

	it("refuses a non-canonical spelling naming the one to send", () => {
		expect(contentLanguageProblem("pt-br")).toBe(
			'"pt-br" is spelled "pt-BR" in canonical form; send that',
		);
		expect(contentLanguageProblem("VI")).toMatch(/"vi"/);
	});

	it("refuses a tag longer than RFC 5646's 35 characters", () => {
		const long = `en-${Array.from({ length: 5 }, () => "abcdefgh").join("-")}`;
		expect(long.length).toBeGreaterThan(35);
		expect(contentLanguageProblem(long)).toMatch(/is not a BCP-47/);
	});
});

describe("contentLanguageOf", () => {
	it("reads en from a project with no document or no key, and says it is the default", () => {
		expect(contentLanguageOf(null)).toEqual({
			contentLanguage: CONTENT_LANGUAGE_DEFAULT,
			keepTermsInEnglish: [],
			source: "default",
		});
		expect(contentLanguageOf({}).source).toBe("default");
	});

	it("reads a declared language and its terms", () => {
		expect(
			contentLanguageOf({
				contentLanguage: "vi",
				keepTermsInEnglish: ["checkout"],
			}),
		).toEqual({
			contentLanguage: "vi",
			keepTermsInEnglish: ["checkout"],
			source: "document",
		});
	});
});

describe("contentLanguageWriteSchema", () => {
	it("takes a revision and a tag, terms optional or null", () => {
		expect(
			contentLanguageWriteSchema.safeParse({
				baseRevision: 3,
				contentLanguage: "vi",
			}).success,
		).toBe(true);
		expect(
			contentLanguageWriteSchema.safeParse({
				baseRevision: 3,
				contentLanguage: "vi",
				keepTermsInEnglish: null,
			}).success,
		).toBe(true);
	});

	it("refuses an unknown key, a missing revision and an over-long term list", () => {
		expect(
			contentLanguageWriteSchema.safeParse({
				baseRevision: 3,
				contentLanguage: "vi",
				language: "vi",
			}).success,
		).toBe(false);
		expect(
			contentLanguageWriteSchema.safeParse({ contentLanguage: "vi" }).success,
		).toBe(false);
		const terms = Array.from({ length: 51 }, (_, i) => `t${i}`);
		expect(
			contentLanguageWriteSchema.safeParse({
				baseRevision: 1,
				contentLanguage: "vi",
				keepTermsInEnglish: terms,
			}).success,
		).toBe(false);
	});
});

it("names a tag in English for the prompt", () => {
	expect(contentLanguageName("vi")).toBe("Vietnamese");
	expect(contentLanguageName("en")).toBe("English");
});
