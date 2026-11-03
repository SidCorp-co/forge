import { describe, expect, it } from "vitest";
import {
	NEEDS_YOU_AREA_SPACE,
	NEEDS_YOU_AREAS,
	NEEDS_YOU_ENTITIES,
	type NeedsYouAreaKey,
	type NeedsYouEntity,
	type NeedsYouItem,
} from "./needs-you.js";
import { say, verbatim } from "./said.js";
import { waitingOn } from "./standing.js";

// The space each row belongs to: what a member owes as a person (`asks`) is what the decisions read
// classifies (`needs-you-decisions.ts`), and Forge's own upkeep (`ops`) is Development's, so a question
// waiting on the person (HOP ISS-107) is a member's ask and an agent report is not. No area lists an
// issue: a run's question on one is a question row, opening the item it is about (REQ-68 BC-6).

const you = waitingOn("you", {
	who: say("standing.who.you"),
	act: say("standing.act.approve"),
	rule: say("standing.text", { text: "asked" }),
});

const asksOf = (rows: readonly NeedsYouItem[]) =>
	rows.filter((r) => r.space === "asks");

const ENTITY_OF: Record<NeedsYouAreaKey, NeedsYouEntity> = {
	requirements: "requirement",
	releases: "release",
	feedback: "feedback",
	contracts: "contract",
	designs: "workflow",
	automation: "schedule",
	questions: "question",
};

const row = (area: NeedsYouAreaKey, key: string): NeedsYouItem => ({
	area,
	space: NEEDS_YOU_AREA_SPACE[area],
	entity: ENTITY_OF[area],
	key,
	title: key,
	titleLang: null,
	waitingOn: you,
	touchedAt: null,
	says: { title: verbatim(key) },
});

describe("the one Needs you", () => {
	const hop = [
		...Array.from({ length: 5 }, (_, i) => row("requirements", `REQ-${i + 1}`)),
		row("releases", "0.6.0"),
		row("feedback", "FB-9"),
		...Array.from({ length: 20 }, (_, i) => row("designs", `wf-${i}`)),
		// the eleven runs' questions HOP's issues held, and ISS-107's, each its own question row
		...Array.from({ length: 11 }, (_, i) => row("questions", `q-${200 + i}`)),
		row("questions", "q-ISS-107"),
		row("automation", "report-1"),
		row("contracts", "c-1"),
	];

	it("places the questions a member owes among their asks", () => {
		const asks = asksOf(hop);
		expect(asks).toHaveLength(39);
		expect(asks.map((r) => r.key)).toContain("q-ISS-107");
	});

	it("lists no issue: no area and no entity is one (REQ-68 BC-6)", () => {
		expect(NEEDS_YOU_AREAS as readonly string[]).not.toContain("issues");
		expect(NEEDS_YOU_ENTITIES as readonly string[]).not.toContain("issue");
		expect(asksOf(hop).map((r) => r.entity)).not.toContain("issue");
	});

	it("leaves Forge ops upkeep — an agent report, a contract repin — to Development", () => {
		expect(asksOf(hop).map((r) => r.area)).not.toContain("automation");
		expect(asksOf(hop).map((r) => r.area)).not.toContain("contracts");
	});

	it("places every area in exactly one space", () => {
		for (const area of NEEDS_YOU_AREAS)
			expect(["asks", "ops"]).toContain(NEEDS_YOU_AREA_SPACE[area]);
	});
});
