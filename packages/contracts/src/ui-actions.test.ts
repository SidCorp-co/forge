import { describe, expect, it } from "vitest";
import {
	describeUiSnapshot,
	highlightRefusal,
	openKindOf,
	parseUiAction,
	UI_ACTION_ADDITIONS,
	UI_ACTIONS,
	UI_ROUTE_ADDITIONS,
	UI_ROUTES,
	type UiSnapshot,
	uiHighlightParamsSchema,
	uiIssueFilterSchema,
	uiOpenParamsSchema,
	uiSnapshotSchema,
} from "./ui-actions.js";

const page = (over: Partial<UiSnapshot>): UiSnapshot => ({
	v: 1,
	route: "other",
	path: "/",
	...over,
});

describe("the registry as offered today", () => {
	it("still refuses an unknown action by name", () => {
		const r = parseUiAction("ui_requirements_filter", { mode: "replace" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("UI_ACTION_UNKNOWN");
	});

	it("keeps the Issues filter at the fields the Issues list applies, until the lane adds waitingOn", () => {
		expect(Object.keys(uiIssueFilterSchema.shape).sort()).toEqual([
			"assignee",
			"createdBy",
			"priority",
			"status",
			"text",
		]);
		expect(uiIssueFilterSchema.safeParse({ waitingOn: "you" }).success).toBe(
			false,
		);
		const r = parseUiAction("ui.issues.filter", {
			mode: "merge",
			set: { priority: "high" },
		});
		expect(r.ok).toBe(true);
	});

	it("refuses an issues filter merge that names nothing, as it always has", () => {
		const r = parseUiAction("ui.issues.filter", { mode: "merge" });
		expect(r.ok).toBe(false);
		if (!r.ok)
			expect(r.message).toContain(
				"a merge must set or clear at least one field",
			);
	});
});

describe("the REQ-41 additions", () => {
	it("name routes and wire names the registry does not already hold, except ui.open which they replace", () => {
		for (const r of Object.keys(UI_ROUTE_ADDITIONS))
			expect(UI_ROUTES).not.toHaveProperty(r);
		const wires = new Set<string>(Object.values(UI_ACTIONS).map((a) => a.wire));
		for (const [name, a] of Object.entries(UI_ACTION_ADDITIONS)) {
			if (name === "ui.open") expect(UI_ACTIONS["ui.open"].wire).toBe(a.wire);
			else {
				expect(UI_ACTIONS).not.toHaveProperty(name);
				expect(wires.has(a.wire)).toBe(false);
			}
			expect(a.wire).toMatch(/^ui_[a-z_]+$/);
		}
	});

	it("filter each Product list in the shape ui.issues.filter has", () => {
		const r = UI_ACTION_ADDITIONS["ui.requirements.filter"].params.safeParse({
			mode: "merge",
			set: { waitingOn: "you" },
		});
		expect(r.success).toBe(true);
	});
});

describe("ui.open opens any record by key (BC-6)", () => {
	it("reads the kind from the key's shape", () => {
		expect(openKindOf("REQ-34")).toBe("requirement");
		expect(openKindOf("FB-52")).toBe("feedback");
		expect(openKindOf("HOP-12")).toBe("issue");
		expect(openKindOf("chat-turn")).toBeNull();
	});

	it("still opens an issue from a call made before kinds existed", () => {
		expect(uiOpenParamsSchema.parse({ key: "ISS-47" })).toEqual({
			kind: "issue",
			key: "ISS-47",
		});
	});

	it("opens a workflow and a release only with their kind named", () => {
		expect(
			uiOpenParamsSchema.parse({ kind: "workflow", key: "chat-turn" }),
		).toEqual({ kind: "workflow", key: "chat-turn" });
		expect(
			uiOpenParamsSchema.parse({ kind: "release", key: "0.4.0-dev.217" }).kind,
		).toBe("release");
		const r = uiOpenParamsSchema.safeParse({ key: "chat-turn" });
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toContain(
			'name kind "workflow" or "release"',
		);
	});

	it("refuses a key its named kind does not take, naming the shape it takes", () => {
		const r = uiOpenParamsSchema.safeParse({
			kind: "requirement",
			key: "FB-3",
		});
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toContain("REQ-30");
	});
});

describe("ui.highlight fits the page it is sent to", () => {
	const req = page({
		route: "requirement",
		item: { kind: "requirement", key: "REQ-34" },
	});

	it("marks a section the open record's page has", () => {
		expect(
			highlightRefusal({ target: "section", section: "question" }, req),
		).toBeNull();
	});

	it("refuses a section another kind of page has, naming the ones this page has", () => {
		const why = highlightRefusal(
			{ target: "section", section: "evidence" },
			req,
		);
		expect(why).toMatch(
			/^UI_ACTION_NOT_ON_PAGE: .*a requirement page does not have \(it has waiting, question/,
		);
	});

	it("refuses a step with no workflow open and a row the list is not showing", () => {
		expect(highlightRefusal({ target: "step", step: "check" }, req)).toContain(
			"no workflow is open",
		);
		const list = page({ route: "issues", shown: ["ISS-1"] });
		expect(highlightRefusal({ target: "row", key: "ISS-1" }, list)).toBeNull();
		expect(highlightRefusal({ target: "row", key: "ISS-2" }, list)).toContain(
			"not showing",
		);
	});

	it("refuses a section that is on no page at all", () => {
		expect(
			uiHighlightParamsSchema.safeParse({
				target: "section",
				section: "footer",
			}).success,
		).toBe(false);
	});
});

describe("what the page reports (BC-8)", () => {
	it("takes a Product list's filter, the rows it shows and its highlight, and says them", () => {
		const s = uiSnapshotSchema.parse({
			v: 1,
			route: "requirements",
			path: "/projects/forge-dev/requirements",
			listFilter: { list: "requirements", filter: { waitingOn: "you" } },
			shown: ["REQ-36", "REQ-35", "REQ-34", "REQ-40", "REQ-39", "REQ-37"],
			highlight: { target: "row", key: "REQ-34" },
		});
		expect(describeUiSnapshot(s)).toBe(
			"requirements · waiting on you · showing REQ-36, REQ-35, REQ-34, REQ-40, REQ-39 and 1 more · highlighting REQ-34",
		);
	});

	it("refuses more shown rows than it reports", () => {
		const shown = Array.from({ length: 51 }, (_, i) => `REQ-${i + 1}`);
		expect(
			uiSnapshotSchema.safeParse({
				v: 1,
				route: "requirements",
				path: "/",
				shown,
			}).success,
		).toBe(false);
	});
});
