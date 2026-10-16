import { describe, expect, it } from "vitest";
import {
	type ApprovalItem,
	approvalInboxSchema,
	approvalItemSchema,
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
		expect(approvalInboxSchema.safeParse({ generatedAt: "2026-10-16T00:00:00.000Z", items: [], total: 0 }).success).toBe(true);
		const many = Array.from({ length: 301 }, (_, i) => row({ id: `m-${i}` }));
		expect(approvalInboxSchema.safeParse({ generatedAt: "2026-10-16T00:00:00.000Z", items: many, total: 301 }).success).toBe(false);
	});
});
