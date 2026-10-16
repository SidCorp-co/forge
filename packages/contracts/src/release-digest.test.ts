import { describe, expect, it } from "vitest";
import {
	RELEASE_PEEK_LINES_MAX,
	releaseChangeGroupOf,
	releaseGlanceOf,
	releasePeekLines,
} from "./release-digest.js";
import type { ReleasePage, ReleasePageChange } from "./release-page.js";

function page(over: Partial<ReleasePage> = {}): ReleasePage {
	return {
		view: "user",
		projectId: "p1",
		header: {
			version: "1.2.0",
			name: null,
			summary: null,
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
		internal: { count: 0, changes: null },
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
	detail: null,
	requirementKey: null,
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

describe("releaseGlanceOf: the groups a reader scans by", () => {
	it("groups Security and Removed entries apart from the fixes and improvements, and counts other changes and open checks by issue", () => {
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
			improved: ["ISS-2"],
			fixed: ["ISS-4", "ISS-6"],
			security: ["ISS-5"],
			removed: ["ISS-3"],
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

describe("releasePeekLines: the overview the peek shows, shortened (REQ-40 BC-18)", () => {
	const LONG =
		"Giờ đây, khi deploy lại thiết kế lên cửa hàng ePOD, sản phẩm đã có được cập nhật tại chỗ thay vì báo lỗi trùng SKU, kể cả khi thử lại nhiều lần.";

	it(`shows the first ${RELEASE_PEEK_LINES_MAX} changes in reading order, each whole, and how many more the page holds`, () => {
		const fixes = Array.from({ length: 7 }, (_, i) =>
			change(`ISS-${10 + i}`, "fixed", "Fixed", i === 0 ? LONG : `fix ${i}`),
		);
		const out = releasePeekLines(
			page({
				improvements: [
					change("ISS-1", "improved", "Removed"),
					change("ISS-2", "new", "Added"),
					change("ISS-3", "improved", "Changed"),
				],
				fixes: [...fixes, change("ISS-9", "fixed", "Security")],
			}),
		);
		expect(out.shown.map((l) => l.change.issueKey)).toEqual([
			"ISS-2",
			"ISS-3",
			"ISS-10",
			"ISS-11",
			"ISS-12",
			"ISS-13",
			"ISS-14",
			"ISS-15",
		]);
		expect(out.more).toBe(3);
		// the peek never cuts a line: the first fix is its whole sentence
		expect(out.shown[2]?.change.line).toBe(LONG);
	});

	it("says no more where the page holds no more than the peek shows", () => {
		expect(releasePeekLines(page({ fixes: [change("ISS-1", "fixed", "Fixed")] }))).toEqual({
			shown: [{ group: "fixed", change: change("ISS-1", "fixed", "Fixed") }],
			more: 0,
		});
	});
});

describe("releaseGlanceOf: what is counted apart (REQ-40 BC-16)", () => {
	it("counts the changes nobody using the product sees apart from the changes users read", () => {
		const g = releaseGlanceOf(
			page({
				fixes: [change("ISS-1", "fixed", "Fixed")],
				internal: { count: 2, changes: null },
			}),
		);
		expect(g.internal).toBe(2);
		expect(Object.values(g.groups).flat()).toHaveLength(1);
	});
});
