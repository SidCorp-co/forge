import { describe, expect, it } from "vitest";
import { say, sayEn } from "./said.js";

// An owed check or breakdown is owed from the moment it opens; its SLA date is the latest day it
// may wait. The epod master read "due 2026-11-13" as a start date and parked a delivered
// requirement's check (ISS-1113), so the words say "now" before any date.

const when = say("standing.due", { date: "2026-11-13" });

describe("a deadline reads as owed now, the date as the latest day", () => {
	it("says the acceptance check is owed now", () => {
		const act = sayEn(say("standing.act.check", { codes: "BC-1, BC-2", when }));
		expect(act).toBe(
			"check BC-1, BC-2 against the traceability matrix now; latest 2026-11-13",
		);
	});

	it("says the breakdown is owed now", () => {
		expect(sayEn(say("standing.act.breakDownBy", { when }))).toBe(
			"break down now; latest 2026-11-13",
		);
	});

	it("says the check's rule is now, with the latest day and its working days", () => {
		const rule = sayEn(
			say("requirements.rule.check", {
				r: 3,
				date: "2026-11-13",
				days: 5,
				overdue: null,
			}),
		);
		expect(rule).toBe(
			"delivered at r3; the BA checks now, latest 2026-11-13 (5 working days)",
		);
	});

	it("says the breakdown's rule is now, with the latest day", () => {
		expect(
			sayEn(
				say("requirements.rule.breakdownDue", { date: "2026-11-13", days: 2 }),
			),
		).toBe(
			"agreed, no issue; break it down now, latest 2026-11-13 (2 working days)",
		);
	});

	it("keeps an overdue check said as overdue", () => {
		const late = say("standing.overdueSince", { date: "2026-11-13" });
		expect(
			sayEn(say("standing.act.check", { codes: "BC-1", when: late })),
		).toBe(
			"check BC-1 against the traceability matrix now; overdue since 2026-11-13",
		);
	});

	it("never words a deadline as a date to wait for", () => {
		for (const s of [
			sayEn(say("standing.act.check", { codes: "BC-1", when })),
			sayEn(say("standing.act.breakDownBy", { when })),
			sayEn(
				say("requirements.rule.check", {
					r: 1,
					date: "2026-11-13",
					days: 5,
					overdue: null,
				}),
			),
		])
			expect(s).not.toMatch(/\b(due|by) 2026-11-13/);
	});
});
