import { describe, expect, it } from "vitest";
import { WRITTEN_LANGS, writtenLangOfTag, writtenLangOfText, writtenLangSchema } from "./written-lang.js";

// The language a writer declares is input like any other: one the list holds is kept as sent, any
// other is refused by name with the list, never coerced to the nearest one.

describe("the language a text was written in", () => {
	it("keeps a declared language the list holds", () => {
		for (const lang of WRITTEN_LANGS) expect(writtenLangSchema.parse(lang)).toBe(lang);
	});

	it("refuses one outside the list by name, with the list and the value sent", () => {
		for (const sent of ["fr", "EN", "vi-VN", "", 1]) {
			const parsed = writtenLangSchema.safeParse(sent);
			expect(parsed.success).toBe(false);
			expect(parsed.error?.issues[0]?.message).toBe(`WRITTEN_LANG_INVALID: writtenLang must be one of en, vi; got ${JSON.stringify(sent)}`);
		}
	});

	it("reads a tag's base language, and no language for a tag outside the list", () => {
		expect(writtenLangOfTag("vi-VN")).toBe("vi");
		expect(writtenLangOfTag("EN")).toBe("en");
		expect(writtenLangOfTag("fr")).toBeNull();
		expect(writtenLangOfTag(null)).toBeNull();
	});

	it("reads what a text's own letters settle, and nothing where they settle nothing", () => {
		// an agent told to write Vietnamese that wrote English (hop /status, 2026-10-08)
		expect(writtenLangOfText("Missing CLI verb: no `forge` verb links an issue to a requirement.")).toBe("en");
		expect(writtenLangOfText("Sửa lỗi đăng nhập")).toBe("vi"); // i18n-allow: Vietnamese text under test
		expect(writtenLangOfText("Integration issue cho IT")).toBeNull();
		expect(writtenLangOfText("Fix login")).toBeNull();
		expect(writtenLangOfText("0b97a1f 2026-10-08")).toBeNull();
		expect(writtenLangOfText("")).toBeNull();
	});
});
