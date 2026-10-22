import { describe, expect, it } from "vitest";
import {
	STEWARD_MERGE_SHARED_TERMS_MIN,
	stewardDecisionEffect,
	stewardDecisionQuestion,
	stewardSharedTerms,
} from "./steward.js";

const DRAFT = { kind: "issue" as const, draft: true };

describe("a steward decision's question (REQ-48 r3 BC-14)", () => {
	it("is one plain sentence built from its options, without the title or the recommendation", () => {
		const q = stewardDecisionQuestion(
			["steward.open", "steward.merge:ISS-607", "steward.keep", "steward.drop"],
			DRAFT,
		);
		expect(q).toBe(
			"Open it, merge it into ISS-607, keep it as a draft, or drop it?",
		);
		expect(q).not.toMatch(/Recommended|stuck|"/);
		expect(q.match(/[.?!]/g)).toEqual(["?"]);
	});

	it("names each item's own clauses: two joined by or, a feedback drop a decline", () => {
		expect(
			stewardDecisionQuestion(["steward.keep", "steward.drop"], {
				kind: "feedback",
				draft: false,
			}),
		).toBe("Keep it waiting or decline it?");
		expect(
			stewardDecisionQuestion(
				["steward.link:REQ-48:BC-5", "steward.requirement", "steward.drop"],
				DRAFT,
			),
		).toBe("Link it to REQ-48 BC-5, start a requirement from it, or drop it?");
	});
});

describe("a merge offered only into an item about the same thing (REQ-48 r3 BC-16)", () => {
	it("finds no subject shared by ISS-625 and ISS-607", () => {
		const shared = stewardSharedTerms(
			"Issue criterion BC trace syntax is undocumented; a trailing tag silently traces nothing",
			"Steward re-asks a master for release approvals it cannot give",
		);
		expect(shared).toEqual([]);
		expect(shared.length).toBeLessThan(STEWARD_MERGE_SHARED_TERMS_MIN);
	});

	it("meets plurals and tenses of the same words", () => {
		expect(
			stewardSharedTerms(
				"A trailing BC tag silently traces nothing",
				"Criterion traces drop a trailing tag",
			),
		).toEqual(["trail", "tag", "trace"]);
	});

	it("says what the two share on the merge's effect", () => {
		expect(
			stewardDecisionEffect("merge", {
				kind: "issue",
				key: "ISS-9",
				draft: true,
				option: "steward.merge:ISS-4",
				shares: "the export's column order.",
			}),
		).toBe(
			"Copies ISS-9's text to ISS-4 as a comment, then drops ISS-9, as you. Both are about the export's column order.",
		);
	});
});
