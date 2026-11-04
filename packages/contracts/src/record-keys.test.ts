// ISS-951 round 4: judge run e0121211 at dev.486 read raw keys as text on Activity, from the words the
// asking runs wrote ("ISS-673 c1 failed again…", "ISS-582 (from hop FB-147): how should…"). The text a
// person reads has them taken out, and nothing else.

import { describe, expect, it } from "vitest";
import { withoutRecordKeys } from "./record-keys.js";

const KEY = /\b(?:ISS|REQ|FB|MK|AF)-\d+\b/;

describe("withoutRecordKeys", () => {
	it.each([
		[
			"ISS-673 c1 failed again after its one fix round (2026-10-24). Second fix round, or accept c1 as it stands?",
			"C1 failed again after its one fix round (2026-10-24). Second fix round, or accept c1 as it stands?",
		],
		[
			"ISS-582 (from hop FB-147): how should a product tour be drawn in a ux-flow design?",
			"How should a product tour be drawn in a ux-flow design?",
		],
		["FB-147 — the tour has no node type", "The tour has no node type"],
		["Close REQ-66 once ISS-639 and ISS-643 land", "Close once land"],
		["Drop ISS-673?", "Drop?"],
		["Re-plan [ISS-695] against REQ-63 r11", "Re-plan against r11"],
		["AF-144 builds the timeline", "Builds the timeline"],
	])("%s", (text, read) => {
		const out = withoutRecordKeys(text, ["AF"]);
		expect(out).toBe(read);
		expect(out).not.toMatch(KEY);
	});

	it("leaves text naming no key as it is, and what only looks like one", () => {
		for (const text of ["Can the stg vhost be changed today?", "Reads UTF-8 and SHA-256 names", "BC-4 of the requirement"]) {
			expect(withoutRecordKeys(text)).toBe(text);
		}
	});

	it("reads a project's own prefix only where it is given", () => {
		expect(withoutRecordKeys("AF-12 lands")).toBe("AF-12 lands");
		expect(withoutRecordKeys("AF-12 lands", ["af"])).toBe("Lands");
	});

	it("text that is only keys reads as empty", () => {
		expect(withoutRecordKeys("ISS-1, ISS-2")).toBe("");
	});
});
