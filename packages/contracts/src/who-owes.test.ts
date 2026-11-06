import { describe, expect, it } from "vitest";
import { DECISION_ACT_NAMES, DECISION_ACT_OF_SAID } from "./needs-you-decisions.js";
import { PERSON_GATES } from "./person-gates.js";
import { OWED_ACTS, type OwedPolicy, owedActOfSaid, OTHER_OWED_ACTS, whoOwes } from "./who-owes.js";

const OPEN: OwedPolicy = {
	strict: false,
	gates: Object.fromEntries(PERSON_GATES.map((g) => [g, false])) as OwedPolicy["gates"],
	releaseApproval: false,
};

describe("who owes an act (ISS-1058): one table, serious or routine", () => {
	it("names every act kind a button or a release gate asks for, each with why", () => {
		for (const kind of [...DECISION_ACT_NAMES, ...OTHER_OWED_ACTS]) {
			const rule = OWED_ACTS[kind];
			expect(rule, kind).toBeDefined();
			expect(rule.why.length, kind).toBeGreaterThan(20);
		}
	});

	it("gives every said act a person decides an act kind, so no surface reads a key the table misses", () => {
		for (const key of Object.keys(DECISION_ACT_OF_SAID)) {
			expect(owedActOfSaid(key), key).not.toBeNull();
		}
		expect(owedActOfSaid("standing.act.splitRelease")).toBe("release.split");
		expect(owedActOfSaid("standing.act.recordLanding")).toBe("release.record");
		expect(owedActOfSaid("standing.act.confirmAnswer")).toBe("feedback.verify");
		expect(owedActOfSaid("standing.act.sayIfGone")).toBe("feedback.verify");
		expect(owedActOfSaid("standing.act.cutThenApprove")).toBe("release.cutAndApprove");
		expect(owedActOfSaid("standing.act.breakDown")).toBeNull();
	});

	it("names the master for a routine act on a project that turned no person's gate on", () => {
		for (const kind of [
			"release.split",
			"release.record",
			"release.cut",
			"release.decide",
			"release.cutAndApprove",
			"feedback.verify",
			"requirement.repin",
		] as const) {
			expect(whoOwes(kind, OPEN).by, kind).toBe("master");
		}
	});

	it("names a person for an act serious by its kind, whatever the policy", () => {
		expect(whoOwes("release.setup", OPEN)).toMatchObject({ by: "person", because: "credentials" });
		expect(whoOwes("question.answer", OPEN)).toMatchObject({ by: "person", because: "asked" });
		expect(whoOwes("mockup.accept", OPEN)).toMatchObject({ by: "person", because: "direction" });
	});

	it("names a person where what the act carries cannot be undone", () => {
		const drops = { irreversible: ["drops the table legacy_orders"] };
		for (const kind of ["release.cut", "release.decide", "release.split", "release.record"] as const) {
			const owed = whoOwes(kind, OPEN, drops);
			expect(owed, kind).toMatchObject({ by: "person", because: "irreversible" });
			expect(owed.why).toContain("legacy_orders");
		}
		// content never makes an act serious that does not read it
		expect(whoOwes("feedback.verify", OPEN, drops).by).toBe("master");
		expect(whoOwes("release.cut", OPEN, { irreversible: [] }).by).toBe("master");
	});

	it("keeps an act a person's where the project's own policy turned that person's gate on", () => {
		const approval = { ...OPEN, releaseApproval: true };
		expect(whoOwes("release.decide", approval)).toMatchObject({ by: "person", because: "policy" });
		expect(whoOwes("release.cutAndApprove", approval).by).toBe("person");
		// the approval switch keeps the approval, never the cut or the split
		expect(whoOwes("release.cut", approval).by).toBe("master");
		expect(whoOwes("release.split", approval).by).toBe("master");
		const strict = { ...OPEN, strict: true };
		for (const kind of ["release.split", "release.record", "release.cut", "feedback.verify"] as const) {
			expect(whoOwes(kind, strict), kind).toMatchObject({ by: "person", because: "policy" });
		}
		const designs = { ...OPEN, gates: { ...OPEN.gates, designs: true } };
		expect(whoOwes("design.decide", designs).by).toBe("person");
		expect(whoOwes("design.decide", OPEN).by).toBe("master");
	});
});
