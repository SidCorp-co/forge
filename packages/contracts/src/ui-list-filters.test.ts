import { describe, expect, it } from "vitest";
import { say } from "./said.js";
import { type WaitingKind, waitingOn } from "./standing.js";
import {
	describeListFilter,
	listFilterFromSearch,
	matchesListFilter,
	UI_FILTER_PARAMS,
	UI_LIST_FILTERS,
	UI_LISTS,
	uiListFilterParams,
	uiListFilterSnapshotSchema,
	waitingFilterOf,
	withinSince,
} from "./ui-list-filters.js";

const wait = (kind: WaitingKind) =>
	waitingOn(kind, {
		who: say("standing.who.nobody"),
		act: say("standing.act.none"),
		rule: say("standing.text", { text: "t" }),
	});

describe("who a row waits on, as every list filters it (BC-5)", () => {
	it("reads you, an agent, or running from the standing alone", () => {
		expect(waitingFilterOf({ waitingOn: wait("you") })).toBe("you");
		for (const k of ["agent", "master", "judge"] as const)
			expect(waitingFilterOf({ waitingOn: wait(k) })).toBe("agent");
		for (const k of ["run", "issue", "feedback"] as const)
			expect(waitingFilterOf({ waitingOn: wait(k) })).toBe("running");
	});

	it("reads a requirement in delivery as running by its group", () => {
		expect(
			waitingFilterOf({ attentionGroup: "moving", waitingOn: wait("release") }),
		).toBe("running");
	});

	it("answers to none of the three when it waits on another person, a release, a gate or nobody", () => {
		for (const k of ["person", "admins", "release", "gate", "none"] as const)
			expect(
				waitingFilterOf({ attentionGroup: "waiting", waitingOn: wait(k) }),
			).toBeNull();
	});

	it("never reads another person's wait as yours", () => {
		expect(
			waitingFilterOf({
				attentionGroup: "needs_you",
				waitingOn: wait("person"),
			}),
		).toBeNull();
	});
});

describe("each list's filter", () => {
	it("filters every list by waitingOn", () => {
		for (const list of UI_LISTS)
			expect(Object.keys(UI_LIST_FILTERS[list].shape)).toContain("waitingOn");
	});

	it("holds every field in a named URL param", () => {
		for (const list of UI_LISTS)
			for (const field of Object.keys(UI_LIST_FILTERS[list].shape))
				expect(UI_FILTER_PARAMS).toHaveProperty(field);
	});

	it("keeps text in q, where the list search already writes it", () => {
		expect(UI_FILTER_PARAMS.text).toBe("q");
	});

	it("refuses a field the list does not have, by name", () => {
		const r = uiListFilterParams("workflows").safeParse({
			mode: "merge",
			set: { phase: ["new"] },
		});
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error?.issues)).toContain("phase");
	});

	it("refuses a waiting filter outside the three", () => {
		const r = uiListFilterParams("requirements").safeParse({
			mode: "merge",
			set: { waitingOn: "person" },
		});
		expect(r.success).toBe(false);
	});

	it("refuses a merge that changes nothing, and a field both set and cleared", () => {
		const p = uiListFilterParams("feedback");
		expect(p.safeParse({ mode: "merge" }).success).toBe(false);
		expect(
			p.safeParse({ mode: "merge", set: { since: "7d" }, clear: ["since"] })
				.success,
		).toBe(false);
	});

	it("takes the mockup's feedback filter: new this week", () => {
		const r = uiListFilterParams("feedback").parse({
			mode: "replace",
			set: { phase: ["new"], since: "7d" },
		});
		expect(r).toEqual({
			mode: "replace",
			set: { phase: ["new"], since: "7d" },
			clear: [],
		});
	});

	it("reports a Product list's filter in the snapshot by list", () => {
		expect(
			uiListFilterSnapshotSchema.safeParse({
				list: "requirements",
				filter: { waitingOn: "you" },
			}).success,
		).toBe(true);
		expect(
			uiListFilterSnapshotSchema.safeParse({
				list: "requirements",
				filter: { phase: ["new"] },
			}).success,
		).toBe(false);
	});
});

describe("since and the words Sees reads", () => {
	it("counts a row filed 7 days ago inside 7d and one filed 8 days ago outside", () => {
		const now = new Date("2026-10-09T12:00:00Z");
		expect(withinSince("7d", new Date("2026-10-02T12:00:00Z"), now)).toBe(true);
		expect(withinSince("7d", new Date("2026-10-01T11:59:59Z"), now)).toBe(
			false,
		);
	});

	it("says each field", () => {
		expect(
			describeListFilter({
				waitingOn: "you",
				state: ["draft", "agreed"],
				text: "chat",
			}),
		).toEqual(["waiting on you", "state draft/agreed", '"chat"']);
	});
});

describe("a list reads its filter from the URL the chat's action writes (BC-4, BC-7)", () => {
	it("reads each field from its one param, a multi-valued one split at commas", () => {
		expect(
			listFilterFromSearch(
				"feedback",
				"?waiting=you&phase=new,triaged&kind=bug&severity=high&since=7d&q=export&peek=FB-2",
			),
		).toEqual({
			waitingOn: "you",
			phase: ["new", "triaged"],
			kind: ["bug"],
			severity: "high",
			since: "7d",
			text: "export",
		});
	});

	it("leaves out a value its field does not take, and a field the list does not have", () => {
		expect(
			listFilterFromSearch(
				"requirements",
				"waiting=nobody&state=agreed,bogus&phase=new",
			),
		).toEqual({ state: ["agreed"] });
	});

	it("leaves the signed-in person's fields to the list that knows the id", () => {
		expect(
			listFilterFromSearch("issues", "createdBy=u-1&waiting=agent"),
		).toEqual({
			waitingOn: "agent",
		});
	});
});

describe("a row stays on a list only where every field it sets holds (BC-5)", () => {
	const row = {
		waiting: "you" as const,
		text: "REQ-34 Export reports",
		state: "agreed",
		createdAt: "2026-10-08T00:00:00Z",
	};
	const now = new Date("2026-10-09T00:00:00Z");

	it("keeps a row waiting on you under waitingOn you, and drops it under agent or running", () => {
		expect(matchesListFilter({ waitingOn: "you" }, row, now)).toBe(true);
		expect(matchesListFilter({ waitingOn: "agent" }, row, now)).toBe(false);
		expect(matchesListFilter({ waitingOn: "running" }, row, now)).toBe(false);
	});

	it("drops a row that answers to none of the three under any waiting filter", () => {
		expect(
			matchesListFilter({ waitingOn: "you" }, { ...row, waiting: null }, now),
		).toBe(false);
		expect(matchesListFilter({}, { ...row, waiting: null }, now)).toBe(true);
	});

	it("reads text, a value set and since", () => {
		expect(matchesListFilter({ text: "export" }, row, now)).toBe(true);
		expect(matchesListFilter({ text: "import" }, row, now)).toBe(false);
		expect(matchesListFilter({ state: ["draft", "agreed"] }, row, now)).toBe(
			true,
		);
		expect(matchesListFilter({ state: ["draft"] }, row, now)).toBe(false);
		expect(matchesListFilter({ since: "1d" }, row, now)).toBe(true);
		expect(
			matchesListFilter({ since: "1d" }, { ...row, createdAt: undefined }, now),
		).toBe(false);
	});

	it("refuses a field it cannot read rather than pass it over", () => {
		expect(() => matchesListFilter({ createdBy: "me" }, row, now)).toThrow(
			/does not read "createdBy"/,
		);
	});
});
