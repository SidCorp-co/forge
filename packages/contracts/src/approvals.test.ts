import { describe, expect, it } from "vitest";
import {
	type ApprovalItem,
	approvalInboxSchema,
	approvalItemSchema,
	approvalTitle,
	byWaitedLongest,
} from "./approvals.js";

const row = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
	kind: "mockup",
	id: "mockup:m-1",
	key: "MK-1",
	title: "the checkout as it should look",
	suggestionKind: null,
	mockupKind: "html",
	revision: null,
	askedBy: { kind: "person", name: "Ana" },
	since: "2026-10-12T09:00:00.000Z",
	opens: { kind: "issue", key: "ISS-4" },
	approve: {
		act: "mockup.accept",
		path: "/api/projects/p-1/mockups/MK-1/accept",
		body: {},
		reason: "optional",
	},
	decline: {
		act: "mockup.return",
		path: "/api/projects/p-1/mockups/MK-1/return",
		body: {},
		reason: "required",
	},
	...over,
});

describe("an approval row", () => {
	it("takes a mockup waiting on its accept", () => {
		expect(approvalItemSchema.safeParse(row()).success).toBe(true);
	});

	it("takes a row decided on its own page, which opens it and carries no button", () => {
		const repin = row({ kind: "repin", approve: null, decline: null, opens: { kind: "workflow", key: "intake" } });
		expect(approvalItemSchema.safeParse(repin).success).toBe(true);
	});

	it("refuses a row that neither decides here nor opens a page", () => {
		const r = approvalItemSchema.safeParse(row({ approve: null, decline: null, opens: null }));
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toContain("never neither");
	});

	it("refuses a decline that takes no reason", () => {
		const decline = { act: "mockup.return", path: "/api/projects/p-1/mockups/MK-1/return", body: {}, reason: "optional" } as const;
		const r = approvalItemSchema.safeParse(row({ decline }));
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.path).toEqual(["decline", "reason"]);
	});

	it("refuses a path with a param left unfilled", () => {
		const approve = { act: "mockup.accept", path: "/api/projects/:projectId/mockups/MK-1/accept", body: {}, reason: "optional" } as const;
		expect(approvalItemSchema.safeParse(row({ approve })).success).toBe(false);
	});

	it("refuses an act no record's page performs", () => {
		const approve = { act: "mockup.approve", path: "/api/projects/p-1/mockups/MK-1/accept", body: {}, reason: "optional" };
		expect(approvalItemSchema.safeParse({ ...row(), approve }).success).toBe(false);
	});
});

describe("the inbox order: what has waited longest leads", () => {
	it("puts the oldest first and a row with no time last", () => {
		const a = row({ id: "a", since: "2026-10-14T00:00:00.000Z" });
		const b = row({ id: "b", since: "2026-10-01T00:00:00.000Z" });
		const c = row({ id: "c", since: null });
		expect([a, c, b].sort(byWaitedLongest).map((r) => r.id)).toEqual(["b", "a", "c"]);
	});

	it("orders two rows asked at the same instant by id, so the order is total", () => {
		const at = "2026-10-01T00:00:00.000Z";
		expect([row({ id: "z", since: at }), row({ id: "m", since: at })].sort(byWaitedLongest).map((r) => r.id)).toEqual(["m", "z"]);
	});

	it("holds an empty inbox and caps the rows one answer carries", () => {
		expect(approvalInboxSchema.safeParse({ generatedAt: "2026-10-16T00:00:00.000Z", items: [], unreadable: [], total: 0 }).success).toBe(true);
		const many = Array.from({ length: 301 }, (_, i) => row({ id: `m-${i}` }));
		expect(approvalInboxSchema.safeParse({ generatedAt: "2026-10-16T00:00:00.000Z", items: many, unreadable: [], total: 301 }).success).toBe(false);
	});
});

describe("a row's title", () => {
	const prose = Array.from({ length: 120 }, (_, i) => `because${i}`).join(" ");

	it("refuses a title past its bound, so a row is never built from one uncut", () => {
		expect(approvalItemSchema.safeParse(row({ title: prose })).success).toBe(false);
	});

	it("is cut at a whole word to fit, and the cut row is taken", () => {
		const title = approvalTitle(prose);
		expect(title.length).toBeLessThanOrEqual(500);
		expect(title.endsWith("…")).toBe(true);
		expect(approvalItemSchema.safeParse(row({ title })).success).toBe(true);
	});
});

describe("a record no row could be made of", () => {
	it("is carried by name beside the rows, and counts in the total", () => {
		const r = approvalInboxSchema.safeParse({
			generatedAt: "2026-10-16T00:00:00.000Z",
			items: [row()],
			unreadable: [{ kind: "suggestion", id: "suggestion:s-1", key: "ISS-4", opens: { kind: "issue", key: "ISS-4" }, problem: "askedBy.name: longer than 200 characters" }],
			total: 2,
		});
		expect(r.success).toBe(true);
	});

	it("is refused with no words saying what could not be read", () => {
		const r = approvalInboxSchema.safeParse({
			generatedAt: "2026-10-16T00:00:00.000Z",
			items: [],
			unreadable: [{ kind: "suggestion", id: "suggestion:s-1", key: "ISS-4", opens: null, problem: "" }],
			total: 1,
		});
		expect(r.success).toBe(false);
	});
});
