import { describe, expect, it } from "vitest";
import {
	NEEDS_YOU_AREA_SPACE,
	NEEDS_YOU_AREAS,
	type NeedsYouAreaKey,
	type NeedsYouItem,
} from "./needs-you.js";
import { say, verbatim } from "./said.js";
import { waitingOn } from "./standing.js";

// The space each row belongs to: what a member owes as a person (`asks`) is what the decisions read
// classifies (`needs-you-decisions.ts`), and Forge's own upkeep (`ops`) is Development's, so a question
// waiting on the person (HOP ISS-107) is a member's ask and an agent report is not.

const you = waitingOn("you", {
	who: say("standing.who.you"),
	act: say("standing.act.approve"),
	rule: say("standing.text", { text: "asked" }),
});

const asksOf = (rows: readonly NeedsYouItem[]) =>
	rows.filter((r) => r.space === "asks");

const row = (area: NeedsYouAreaKey, key: string): NeedsYouItem => ({
	area,
	space: NEEDS_YOU_AREA_SPACE[area],
	entity: "issue",
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
		...Array.from({ length: 11 }, (_, i) => row("issues", `ISS-${200 + i}`)),
		row("issues", "ISS-107"),
		row("automation", "report-1"),
		row("contracts", "c-1"),
	];

	it("places the issues and questions a member owes among their asks", () => {
		const asks = asksOf(hop);
		expect(asks).toHaveLength(39);
		expect(asks.map((r) => r.key)).toContain("ISS-107");
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
