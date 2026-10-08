import { describe, expect, it } from "vitest";
import {
	asksOf,
	NEEDS_YOU_AREA_SPACE,
	NEEDS_YOU_AREAS,
	type NeedsYouAreaKey,
	type NeedsYouItem,
} from "./needs-you.js";
import { say, verbatim } from "./said.js";
import { waitingOn } from "./standing.js";

// One Needs you: the project home and /attention each read `asksOf` over the rows core marked with
// `NEEDS_YOU_AREA_SPACE`, so a question waiting on the person (HOP ISS-107) is on both or neither.
// HOP on 2026-10-08: home 27, /attention 39, the 12 issues the home's own area list left out.

const you = waitingOn("you", {
	who: say("standing.who.you"),
	act: say("standing.act.approve"),
	rule: say("standing.text", { text: "asked" }),
});

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

	it("counts the issues and questions a member owes, so home equals /attention's section", () => {
		const asks = asksOf(hop);
		expect(asks).toHaveLength(39);
		expect(asks.map((r) => r.key)).toContain("ISS-107");
	});

	it("leaves Forge ops upkeep — an agent report, a contract repin — to Development", () => {
		expect(asksOf(hop).map((r) => r.area)).not.toContain("automation");
		expect(asksOf(hop).map((r) => r.area)).not.toContain("contracts");
	});

	it("places every area in exactly one space", () => {
		for (const area of NEEDS_YOU_AREAS) expect(["asks", "ops"]).toContain(NEEDS_YOU_AREA_SPACE[area]);
	});
});
