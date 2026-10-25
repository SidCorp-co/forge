import { describe, expect, it } from "vitest";
import {
	contentLanguageMisfit,
	contentLanguageScriptWarning,
	SCRIPT_CHECK_MIN_WORDS,
} from "./content-language.js";

const english = "Fixes the login page so a returning user is signed in again";
const vietnamese = "Sửa trang đăng nhập để người dùng cũ được đăng nhập lại";

describe("a note whose script disagrees with the content language", () => {
	it("warns on an English note for a vi project, naming the words counted and the language", () => {
		const said = contentLanguageScriptWarning(
			"vi",
			english,
			"releaseNotes.userFacing",
		);
		expect(said).toContain(
			"releaseNotes.userFacing is 12 words with no Vietnamese letter",
		);
		expect(said).toContain("Vietnamese (`vi`)");
	});
	it("is silent on a Vietnamese note", () => {
		expect(contentLanguageScriptWarning("vi", vietnamese, "x")).toBeNull();
	});
	it("is silent below the word floor and counts the floor itself", () => {
		const five = "Fixes the login page today";
		expect(five.split(" ").length).toBe(SCRIPT_CHECK_MIN_WORDS - 1);
		expect(contentLanguageScriptWarning("vi", five, "x")).toBeNull();
		expect(
			contentLanguageScriptWarning("vi", `${five} now`, "x"),
		).not.toBeNull();
	});
	it("does not count the Skip placeholder or punctuation as words", () => {
		expect(
			contentLanguageScriptWarning("vi", "- - - - - - - -", "x"),
		).toBeNull();
	});
	it("guesses no language but vi", () => {
		expect(contentLanguageScriptWarning("en", vietnamese, "x")).toBeNull();
		expect(contentLanguageScriptWarning("fr", english, "x")).toBeNull();
	});
});

// REQ-69 BC-10: what a chat saves for a project is in the project's language, whichever language the
// person asked in, checked both ways before its card is offered
describe("a chat's saved text against the project's language", () => {
	it("finds Vietnamese text unfit for an English project, naming the count and the language", () => {
		const said = contentLanguageMisfit("en", vietnamese);
		expect(said).toContain(
			"of its 12 words are spelled with Vietnamese letters",
		);
		expect(said).toContain("English (`en`)");
	});
	it("lets an English sentence carry a Vietnamese name", () => {
		expect(
			contentLanguageMisfit(
				"en",
				"Nguyễn asked for the export to keep its filters on reload",
			),
		).toBeNull();
	});
	it("finds English text unfit for a Vietnamese project, and Vietnamese fit", () => {
		expect(contentLanguageMisfit("vi", english)).toContain(
			"no Vietnamese letter",
		);
		expect(contentLanguageMisfit("vi", vietnamese)).toBeNull();
		expect(contentLanguageMisfit("en", english)).toBeNull();
	});
	it("says nothing below the word floor, or for a language it does not guess", () => {
		expect(contentLanguageMisfit("en", "Sửa trang đăng nhập")).toBeNull();
		expect(contentLanguageMisfit("fr", vietnamese)).toBeNull();
	});
});
