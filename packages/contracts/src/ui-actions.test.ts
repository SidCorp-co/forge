import { describe, expect, it } from "vitest";
import {
	describeUiSnapshot,
	highlightRefusal,
	openKindOf,
	parseForwardedUiAction,
	parseUiAction,
	UI_ACTION_NAMES,
	UI_ACTIONS,
	UI_LIST_FILTER_ACTIONS,
	UI_ROUTES,
	type UiSnapshot,
	uiActionJsonSchema,
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
				set: [{ field: "waitingOn", value: "you" }],
			});
			expect(r.ok, name).toBe(true);
		}
	});

	it("filters Issues by whom an issue waits on, now its list reads it (BC-5)", () => {
		expect(Object.keys(uiIssueFilterSchema.shape)).toContain("waitingOn");
		const r = parseUiAction("ui.issues.filter", {
			mode: "merge",
			set: [{ field: "waitingOn", value: "agent" }],
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

	it("takes the call a model naturally makes: one target naming the record key and its section", () => {
		const r = parseUiAction("ui_highlight", {
			target: { key: "ISS-493", section: "plan" },
		});
		expect(r).toMatchObject({
			ok: true,
			action: {
				name: "ui.highlight",
				params: { target: "section", section: "plan", of: "ISS-493" },
			},
		});
		expect(
			parseUiAction("ui_highlight", {
				target: { key: "chat-turn", step: "check" },
			}),
		).toMatchObject({
			ok: true,
			action: { params: { target: "step", step: "check", of: "chat-turn" } },
		});
		expect(
			parseUiAction("ui_highlight", { target: { key: "REQ-34" } }),
		).toMatchObject({
			ok: true,
			action: { params: { target: "row", key: "REQ-34" } },
		});
		expect(
			parseUiAction("ui_highlight", { target: { section: "criteria" } }),
		).toMatchObject({ ok: true, action: { params: { target: "section" } } });
	});

	it("refuses a section its record's page does not have, naming the ones it has", () => {
		const r = parseUiAction("ui_highlight", {
			target: { key: "REQ-31", section: "plan" },
		});
		expect(r).toMatchObject({ ok: false, code: "UI_ACTION_INVALID" });
		expect((r as { message: string }).message).toContain(
			'REQ-31 is a requirement, whose page has waiting, question, criteria, picture, delivery, history, not "plan"',
		);
		expect(
			(
				parseUiAction("ui_highlight", {
					target: { key: "chat-turn", section: "plan" },
				}) as { message: string }
			).message,
		).toContain("is a workflow, which highlights a step");
		expect(
			(
				parseUiAction("ui_highlight", {
					target: { key: "ISS-9", step: "check" },
				}) as { message: string }
			).message,
		).toContain("a step belongs to a workflow");
	});

	it("refuses a target naming nothing, or both a section and a step, by name", () => {
		expect(
			(parseUiAction("ui_highlight", { target: {} }) as { message: string })
				.message,
		).toContain("name what to highlight");
		expect(
			(
				parseUiAction("ui_highlight", {
					target: { section: "plan", step: "check" },
				}) as { message: string }
			).message,
		).toContain("a section or a step, not both");
		expect(
			parseUiAction("ui_highlight", { target: { section: "footer" } }).ok,
		).toBe(false);
	});

	it("refuses the flat call it once took, by name, and offers the model one object with no slot to fill", () => {
		const flat = parseUiAction("ui_highlight", {
			target: "section",
			section: "plan",
		});
		expect(flat.ok).toBe(false);
		const schema = uiActionJsonSchema("ui.highlight") as {
			required: string[];
			properties: { target: { required?: string[]; properties: object } };
		};
		expect(schema.required).toEqual(["target"]);
		expect(schema.properties.target.required).toBeUndefined();
		expect(Object.keys(schema.properties.target.properties)).toEqual([
			"key",
			"section",
			"step",
		]);
	});

	it("marks only the record named, and refuses one the page is not showing", () => {
		const h = { target: "section", section: "criteria", of: "REQ-31" } as const;
		expect(highlightRefusal(h, req)).toContain(
			"names REQ-31, but the page beside the chat shows REQ-34; open REQ-31 with ui.open first",
		);
		expect(highlightRefusal({ ...h, of: "REQ-34" }, req)).toBeNull();
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

describe("a filled-in slot is read, not refused (ISS-495, QA of dev.220)", () => {
	it("reads an empty, null or placeholder section/step as absent and names the key it ignored", () => {
		const r = parseUiAction("ui_highlight", {
			target: { key: "ISS-493", section: "plan", step: "check" },
		});
		expect(r).toMatchObject({
			ok: true,
			action: { params: { target: "section", section: "plan", of: "ISS-493" } },
			ignored: [expect.stringContaining('step "check"')],
		});
		expect(
			parseUiAction("ui_highlight", {
				target: { key: "ISS-493", section: "plan", step: "x" },
			}),
		).toMatchObject({
			ok: true,
			ignored: ['step "x": empty or a placeholder, read as not given'],
		});
		for (const empty of [null, "", "  ", "none", "unused"]) {
			expect(
				parseUiAction("ui_highlight", {
					target: { key: "chat-turn", step: "check", section: empty },
				}),
			).toMatchObject({
				ok: true,
				action: { params: { target: "step", step: "check", of: "chat-turn" } },
			});
		}
	});

	it("refuses two real values with no key to tell them apart, naming both", () => {
		const r = parseUiAction("ui_highlight", {
			target: { section: "plan", step: "check" },
		});
		expect(r).toMatchObject({ ok: false });
		expect((r as { message: string }).message).toContain(
			'section "plan" and step "check"',
		);
	});

	it("takes a filter's set as an object map of only the fields asked, or as the list", () => {
		const asMap = parseUiAction("ui_requirements_filter", {
			mode: "merge",
			set: { waitingOn: "you" },
		});
		const asList = parseUiAction("ui_requirements_filter", {
			mode: "merge",
			set: [{ field: "waitingOn", value: "you" }],
		});
		expect(asMap).toMatchObject({ ok: true });
		expect(asMap.ok && asList.ok && asMap.action).toEqual(
			asList.ok && asList.action,
		);
	});

	it("ignores a map field sent null or empty and says so, and keeps refusing junk by name", () => {
		const r = parseUiAction("ui_feedback_filter", {
			mode: "merge",
			set: { waitingOn: "agent", text: null, severity: "" },
			clear: null,
		});
		expect(r).toMatchObject({
			ok: true,
			action: { params: { set: { waitingOn: "agent" }, clear: [] } },
		});
		expect(r.ok && r.ignored).toEqual(
			expect.arrayContaining(["set.text", "set.severity", "clear"]),
		);
		const junk = parseUiAction("ui_feedback_filter", {
			mode: "merge",
			set: { text: "/" },
		});
		expect((junk as { message: string }).message).toContain(
			"text must hold a word",
		);
	});

	it("reads what core forwarded back into the same action, for every call the model can make", () => {
		const calls: [string, unknown][] = [
			[
				"ui_requirements_filter",
				{ mode: "replace", set: { waitingOn: "agent", text: "chat" } },
			],
			[
				"ui_feedback_filter",
				{
					mode: "merge",
					set: [{ field: "severity", value: "low" }],
					clear: ["since"],
				},
			],
			["ui_highlight", { target: { key: "ISS-493", section: "plan" } }],
			["ui_highlight", { target: { key: "chat-turn", step: "check" } }],
			["ui_highlight", { target: { key: "REQ-34" } }],
			["ui_highlight", { target: { step: "check" } }],
			["ui_open", { key: "FB-110" }],
			["ui_navigate", { route: "feedback" }],
		];
		for (const [name, input] of calls) {
			const sent = parseUiAction(name, input);
			expect(sent.ok, JSON.stringify(sent)).toBe(true);
			if (!sent.ok) continue;
			const back = parseForwardedUiAction(sent.action.name, sent.action.params);
			expect(back.ok && back.action, JSON.stringify(back)).toEqual(sent.action);
		}
	});
});
