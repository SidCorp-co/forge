// ISS-1006 round 2: a decision with no plain text is listed by its question's own line, never by
// less, and no label core builds names its target by an ISS-/REQ-/BC-/FB- key.

import { describe, expect, it } from "vitest";
import { decisionLineOf } from "./plain-decision.js";
import {
	stewardDecisionLabel,
	stewardDecisionQuestion,
	stewardLinkLabel,
	stewardMergeLabel,
	stewardOptionLabel,
} from "./steward.js";

const KEY = /\b(ISS|REQ|BC|FB)-\d+/;

describe("the line a pending decision is listed by", () => {
	it("is the plain text's first line where the asker wrote one", () => {
		expect(
			decisionLineOf({
				plain: "\n  Customers get an Export CSV button.\nSales waits on it.",
				question: "Turn the CSV export on now?",
			}),
		).toEqual({ line: "Customers get an Export CSV button.", fromPlain: true });
	});

	it("is the question's own first line where the asker wrote none: the owner's adminhub-api shape", () => {
		const question =
			"Open it, merge it into another issue, keep it as a draft, or drop it?";
		expect(decisionLineOf({ plain: null, question })).toEqual({
			line: question,
			fromPlain: false,
		});
		expect(decisionLineOf({ question })).toEqual({
			line: question,
			fromPlain: false,
		});
		expect(decisionLineOf({ plain: "  \n ", question })).toEqual({
			line: question,
			fromPlain: false,
		});
	});

	it("takes a long question's first line", () => {
		expect(
			decisionLineOf({
				plain: null,
				question: "Second fix round?\nThe criterion failed twice.",
			}),
		).toEqual({ line: "Second fix round?", fromPlain: false });
	});
});

describe("no label core builds carries a key", () => {
	it("names a merge's target by its title and a link's by its criterion's words", () => {
		const merge = stewardMergeLabel(
			"Declare the response types of 24 order GETs",
		);
		const link = stewardLinkLabel("Every read declares its response type");
		expect(merge).toBe(
			"Merge it into: Declare the response types of 24 order GETs",
		);
		expect(link).toBe(
			"Link it to the criterion: Every read declares its response type",
		);
		expect(merge).not.toMatch(KEY);
		expect(link).not.toMatch(KEY);
	});

	it("reads a round stored with keyed labels as one asked now", () => {
		expect(
			stewardOptionLabel(
				"steward.merge:ISS-98",
				"Merge it into ISS-98: Khai báo kiểu response cho 24 GET",
				"issue",
			),
		).toBe("Merge it into: Khai báo kiểu response cho 24 GET");
		expect(
			stewardOptionLabel(
				"steward.link:REQ-9:BC-2",
				"Link it to REQ-9 BC-2: every read declares its type",
				"issue",
			),
		).toBe("Link it to the criterion: every read declares its type");
		expect(
			stewardOptionLabel(
				"steward.merge:REQ-4",
				"Merge it into REQ-4",
				"requirement",
			),
		).toBe("Merge it into another requirement");
		expect(
			stewardOptionLabel("steward.open", "Open it: admit it for work", "issue"),
		).toBe("Open it: admit it for work");
	});

	it("leaves a key out of every fixed button and of the question a steward decision asks", () => {
		for (const kind of ["issue", "requirement", "feedback"] as const) {
			for (const draft of [true, false]) {
				for (const d of [
					"open",
					"drop",
					"requirement",
					"withdraw",
					"verify",
					"reopen",
					"keep",
				] as const) {
					expect(stewardDecisionLabel(d, { kind, draft })).not.toMatch(KEY);
				}
				expect(
					stewardDecisionQuestion(
						[
							"steward.open",
							"steward.merge:ISS-607",
							"steward.link:REQ-48:BC-5",
							"steward.drop",
						],
						{ kind, draft },
					),
				).not.toMatch(KEY);
			}
		}
	});
});
