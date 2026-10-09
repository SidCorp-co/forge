import { describe, expect, it } from "vitest";
import {
	failingOf,
	requirementStageOf,
	roadmapHorizonOf,
	type StageInput,
} from "./requirement-roadmap.js";

const input = (
	state: StageInput["state"],
	over: { group?: string; whoKey?: string; who?: string } = {},
): StageInput => ({
	state,
	attentionGroup: over.group ?? "agent",
	waitingOn: {
		who: over.who ?? "Master",
		act: "",
		says: { who: { key: over.whoKey ?? "standing.who.master" } },
	},
	facts: { passing: 0, judged: 0, criteria: 0 },
});

describe("a requirement's stage and roadmap horizon (REQ-29 BC-8)", () => {
	it.each([
		["draft", "draft", "next"],
		["agreed", "agreed", "next"],
		["deferred", "deferred", "later"],
		["delivered", "check", "now"],
		["accepted", "done", null],
		["dropped", null, null],
	] as const)("puts a %s requirement at stage %s on %s", (state, stage, horizon) => {
		expect(requirementStageOf(input(state))).toBe(stage);
		expect(roadmapHorizonOf(input(state))).toBe(horizon);
	});

	it("reads work in delivery as building, proving or a decision, all on Now", () => {
		const building = input("in_delivery");
		const proving = input("in_delivery", { whoKey: "standing.who.independentJudge" });
		const deciding = input("in_delivery", { group: "needs_you" });
		expect(requirementStageOf(building)).toBe("build");
		expect(requirementStageOf(proving)).toBe("prove");
		expect(requirementStageOf(deciding)).toBe("decide");
		for (const s of [building, proving, deciding]) expect(roadmapHorizonOf(s)).toBe("now");
	});

	it("reads the judge off the wait's key, so a reworded name does not move the stage", () => {
		const reworded = input("in_delivery", {
			who: "The judge",
			whoKey: "standing.who.independentJudge",
		});
		const lookalike = input("in_delivery", { who: "Independent judge", whoKey: "standing.who.master" });
		expect(requirementStageOf(reworded)).toBe("prove");
		expect(requirementStageOf(lookalike)).toBe("build");
	});

	it("counts failing criteria as judged less passing, never below zero", () => {
		expect(failingOf({ facts: { passing: 2, judged: 5, criteria: 6 } })).toBe(3);
		expect(failingOf({ facts: { passing: 3, judged: 2, criteria: 3 } })).toBe(0);
	});
});
