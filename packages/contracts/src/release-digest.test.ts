import { describe, expect, it } from "vitest";
import {
	RELEASE_ROW_WORDS_MAX,
	releaseChangeGroupOf,
	releaseGlanceOf,
	releaseRowHeadline,
	releaseSummaryOf,
} from "./release-digest.js";
import type { ReleasePage, ReleasePageChange } from "./release-page.js";

function page(over: Partial<ReleasePage> = {}): ReleasePage {
	return {
		view: "user",
		projectId: "p1",
		header: {
			version: "1.2.0",
			state: "draft",
			releasedAt: null,
			environment: null,
			build: null,
			verified: {
				level: "none",
				proven: 0,
				total: 0,
				check: null,
				provider: null,
			},
			approval: { required: false, state: "not_asked", by: null, at: null },
		},
		highlights: { state: "none", why: "no build" },
		requirements: [],
		untraced: null,
		improvements: [],
		fixes: [],
		withoutNotes: [],
		actionRequired: [],
		shipped: { state: "unread", why: "no build" },
		knownIssues: [],
		technical: null,
		can: { share: false, export: false, approve: false },
		...over,
	};
}

const change = (
	issueKey: string,
	kind: ReleasePageChange["kind"],
	section: ReleasePageChange["section"],
	line = `${issueKey} line.`,
): ReleasePageChange => ({
	issueKey,
	kind,
	...(section === undefined ? {} : { section }),
	line,
});
const req = (key: string, title: string, completes: boolean) => ({
	key,
	title,
	completes,
	proven: [],
	unproven: 0,
	business: null,
});
const known = (issueKey: string) => ({
	issueKey,
	requirementKey: null,
	bc: null,
	statement: "s",
	standing: "fail" as const,
	reason: null,
	elsewhere: null,
});

describe("releaseRowHeadline: one change as one short row", () => {
	it("keeps a first sentence that fits whole, and says when the line holds more", () => {
		expect(releaseRowHeadline("Checkout remembers your address.")).toEqual({
			text: "Checkout remembers your address",
			cut: false,
		});
		expect(
			releaseRowHeadline(
				"Checkout remembers your address. It fills it in next time.",
			),
		).toEqual({ text: "Checkout remembers your address", cut: true });
		expect(
			releaseRowHeadline(
				"Giờ có thể deploy lên ePOD; nếu API key bị từ chối thì báo lỗi.",
			),
		).toEqual({ text: "Giờ có thể deploy lên ePOD", cut: true });
	});

	it(`cuts a longer sentence at its last clause within ${RELEASE_ROW_WORDS_MAX} words, or at ${RELEASE_ROW_WORDS_MAX} words with an ellipsis`, () => {
		const clause = releaseRowHeadline(
			"Save any product to your wishlist from its page or the grid, and your list follows you to every device you use.",
		);
		expect(clause).toEqual({
			text: "Save any product to your wishlist from its page or the grid",
			cut: true,
		});
		const words = Array.from({ length: 30 }, (_, i) => `w${i + 1}`).join(" ");
		const hard = releaseRowHeadline(words);
		expect(hard.cut).toBe(true);
		expect(hard.text).toBe(
			`${words.split(" ").slice(0, RELEASE_ROW_WORDS_MAX).join(" ")}…`,
		);
	});

	it("never stops at a comma that leaves a stub", () => {
		const out = releaseRowHeadline(
			"Now, you can save any product to your wishlist from its page or straight from the grid anywhere.",
		);
		expect(out.text.startsWith("Now, you can save")).toBe(true);
		expect(out.text.endsWith("…")).toBe(true);
	});
});

describe("releaseGlanceOf: the groups a reader scans by", () => {
	it("groups a Security entry apart from the fixes, and counts other changes and open checks by issue", () => {
		const g = releaseGlanceOf(
			page({
				improvements: [
					change("ISS-1", "new", "Added"),
					change("ISS-2", "improved", "Changed"),
					change("ISS-3", "improved", "Removed"),
				],
				fixes: [
					change("ISS-4", "fixed", "Fixed"),
					change("ISS-5", "fixed", "Security"),
					change("ISS-6", "fixed", null),
				],
				withoutNotes: [{ issueKey: "ISS-7", title: "t", why: "no_note" }],
				knownIssues: [known("ISS-4"), known("ISS-4"), known("ISS-8")],
			}),
		);
		expect(
			Object.fromEntries(
				Object.entries(g.groups).map(([k, v]) => [k, v.map((c) => c.issueKey)]),
			),
		).toEqual({
			new: ["ISS-1"],
			improved: ["ISS-2", "ISS-3"],
			fixed: ["ISS-4", "ISS-6"],
			security: ["ISS-5"],
		});
		expect(g.other).toBe(1);
		expect(g.open).toEqual({ checks: 3, issues: 2 });
	});

	it("reads a row with no section (a share frozen before rows carried one) by its kind", () => {
		expect(releaseChangeGroupOf(change("ISS-1", "fixed", undefined))).toBe(
			"fixed",
		);
	});
});

describe("releaseSummaryOf: the lines a release opens on", () => {
	it("says what it brings by group, the requirements it completes and moves, its highlights and what is open", () => {
		const out = releaseSummaryOf(
			page({
				improvements: [
					change("ISS-1", "new", "Added"),
					change("ISS-2", "new", "Added"),
					change("ISS-3", "improved", "Changed"),
				],
				fixes: [change("ISS-5", "fixed", "Security")],
				withoutNotes: [{ issueKey: "ISS-7", title: "t", why: "no_note" }],
				requirements: [
					req("REQ-1", "Wishlists", true),
					req("REQ-2", "Search", false),
					req("REQ-3", "Checkout", false),
					req("REQ-4", "Maps", false),
				],
				knownIssues: [known("ISS-1")],
			}),
		);
		expect(out).toEqual({
			state: "derived",
			lines: [
				"This release brings 2 new features, 1 improvement and 1 security fix, plus 1 change with no note for users yet.",
				"It completes “Wishlists” and moves “Search”, “Checkout” and 1 more forward.",
				"1 acceptance check is still open on 1 change.",
			],
		});
	});

	it("says what a release of changes with no note for users carries, rather than refusing it", () => {
		expect(
			releaseSummaryOf(
				page({
					withoutNotes: [
						{ issueKey: "ISS-7", title: "t", why: "no_note" },
						{ issueKey: "ISS-8", title: "t", why: "held" },
					],
				}),
			),
		).toEqual({
			state: "derived",
			lines: ["This release carries 2 changes with no note for users yet."],
		});
	});

	it("refuses by name where the release carries no change and no requirement", () => {
		expect(releaseSummaryOf(page())).toEqual({
			state: "refused",
			refusal: {
				code: "RELEASE_SUMMARY_UNDERIVABLE",
				path: "summary",
				detail:
					"release 1.2.0 carries no change and completes or advances no requirement, so there is nothing to summarise",
			},
		});
	});
});
