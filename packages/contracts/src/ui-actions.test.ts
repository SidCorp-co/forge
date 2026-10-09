import { describe, expect, it } from "vitest";
import {
	describeUiSnapshot,
	highlightRefusal,
	openKindOf,
	parseUiAction,
	UI_ACTION_NAMES,
	UI_ACTIONS,
	UI_LIST_FILTER_ACTIONS,
	UI_ROUTES,
	type UiSnapshot,
	uiActionJsonSchema,
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

describe("the registry offers what every page applies (REQ-41)", () => {
	it("refuses an unknown action by name", () => {
		const r = parseUiAction("ui_settings_filter", { mode: "replace" });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.code).toBe("UI_ACTION_UNKNOWN");
	});

	it("opens Requirements and Feedback by route (BC-4)", () => {
		expect(UI_ROUTES.requirements).toBe("/requirements");
		expect(UI_ROUTES.feedback).toBe("/feedback");
		expect(parseUiAction("ui_navigate", { route: "feedback" }).ok).toBe(true);
	});

	it("filters each Product list in the shape ui.issues.filter has (BC-4)", () => {
		for (const name of Object.values(UI_LIST_FILTER_ACTIONS)) {
			const r = parseUiAction(UI_ACTIONS[name].wire, {
				mode: "merge",
				set: { waitingOn: "you" },
			});
			expect(r.ok, name).toBe(true);
		}
	});

	it("filters Issues by whom an issue waits on, now its list reads it (BC-5)", () => {
		expect(Object.keys(uiIssueFilterSchema.shape)).toContain("waitingOn");
		const r = parseUiAction("ui.issues.filter", {
			mode: "merge",
			set: { waitingOn: "agent" },
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

	it("offers every action's params as one object, which a tool's params must be", () => {
		for (const name of UI_ACTION_NAMES) {
			const schema = uiActionJsonSchema(name);
			expect(schema.type, name).toBe("object");
			expect(schema).not.toHaveProperty("oneOf");
			expect(schema).not.toHaveProperty("anyOf");
		}
	});

	it("names each wire once", () => {
		const wires = UI_ACTION_NAMES.map((n) => UI_ACTIONS[n].wire);
		expect(new Set(wires).size).toBe(wires.length);
		for (const w of wires) expect(w).toMatch(/^ui_[a-z_]+$/);
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

	it("refuses a field its target does not take, and a target without its own, by name", () => {
		const extra = uiHighlightParamsSchema.safeParse({
			target: "row",
			key: "REQ-3",
			section: "criteria",
		});
		expect(extra.success).toBe(false);
		expect(extra.error?.issues[0]?.message).toBe(
			'target "row" takes key, not section',
		);
		const bare = uiHighlightParamsSchema.safeParse({ target: "step" });
		expect(bare.success).toBe(false);
		expect(bare.error?.issues[0]?.message).toBe('target "step" names its step');
		const r = parseUiAction("ui_highlight", { target: "step", step: "check" });
		expect(r.ok).toBe(true);
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
