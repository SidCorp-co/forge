import { describe, expect, it } from "vitest";
import {
	releaseNoteAttention,
	releaseNoteReferenceWarning,
	releaseNoteReferences,
} from "./content-language.js";

describe("a release note that carries an engineer's reference", () => {
	it("names a commit sha of 7 to 40 hex digits", () => {
		expect(releaseNoteReferences("Fixed in 9db12a21a for good")).toEqual([
			"commit sha 9db12a21a",
		]);
		expect(releaseNoteReferences(`Landed ${"a1".repeat(20)} today`)).toHaveLength(1);
	});

	it("does not read a word, a number, or a short hex run as a sha", () => {
		expect(releaseNoteReferences("The page defaced nothing; 2026100 users; abc123")).toEqual([]);
	});

	it("names an ISS-, REQ- or FB- key once, and not also as a code", () => {
		expect(releaseNoteReferences("See ISS-12 and REQ-3, ISS-12 again, FB-9")).toEqual([
			"issue key ISS-12",
			"issue key REQ-3",
			"issue key FB-9",
		]);
	});

	it("names an UPPER_SNAKE or UPPER-KEBAB code of two parts or more", () => {
		expect(releaseNoteReferences("Enforces SOD-RULE-MAKER-CHECKER and RELEASE_RECORD_MISSING")).toEqual([
			"code SOD-RULE-MAKER-CHECKER",
			"code RELEASE_RECORD_MISSING",
		]);
		expect(releaseNoteReferences("Uses the API over HTTP")).toEqual([]);
	});

	it('names a "Technical note" label in any case', () => {
		expect(releaseNoteReferences("Boards load. technical note: index added")).toEqual([
			'label "technical note"',
		]);
	});

	it("is silent on a plain line, and the warning line names every hit and says it was stored", () => {
		expect(releaseNoteReferenceWarning("Saved boards keep every card.", "x")).toBeNull();
		const said = releaseNoteReferenceWarning("Fix 9db12a21a for ISS-4", "releaseNotes.userFacing");
		expect(said).toContain("releaseNotes.userFacing carries commit sha 9db12a21a, issue key ISS-4");
		expect(said).toContain("stored as sent");
	});

	it("reports both problems at once for the attention view", () => {
		expect(
			releaseNoteAttention("vi", "Fixes the login page so a returning user is signed in ISS-4"),
		).toEqual({ notInLanguage: true, references: ["issue key ISS-4"] });
		expect(releaseNoteAttention("en", "Saved boards keep every card.")).toEqual({
			notInLanguage: false,
			references: [],
		});
	});
});
