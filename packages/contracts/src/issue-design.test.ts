/**
 * A design written with a blank part is refused at that part's path in words naming it and the
 * shape it takes, never zod's own text (judge J1 on 0.4.0-dev.222: a blank proof read "Too small:
 * expected string to have >=1 characters", and so did an empty modules list).
 *
 * @direct-test-of packages/contracts/src/issue-design.ts
 */

import { describe, expect, it } from "vitest";
import { recordDesignRequestSchema } from "./issue-design.js";

const whole = {
	criteria: [{ criterion: 1, class: "observable", pattern: "screen", proof: "open the page, see it" }],
	modules: ["issues"],
	contracts: [],
};

const faultsOf = (body: unknown) => {
	const parsed = recordDesignRequestSchema.safeParse(body);
	return parsed.success ? [] : parsed.error.issues.map((i) => [i.path.join("/"), i.message]);
};

describe("a design with a blank part", () => {
	it("takes a whole design", () => {
		expect(faultsOf(whole)).toEqual([]);
	});

	it("refuses a blank proof at its path, saying what a proof is", () => {
		const blank = { ...whole, criteria: [{ ...whole.criteria[0], proof: "   " }] };
		expect(faultsOf(blank)).toEqual([
			["criteria/0/proof", "The proof is blank: name the probe or the review line that will prove this criterion."],
		]);
	});

	it("refuses an empty modules list, and a blank module name, each at its path", () => {
		expect(faultsOf({ ...whole, modules: [] })).toEqual([
			["modules", "No module is named: name at least one module of the project the change touches."],
		]);
		expect(faultsOf({ ...whole, modules: [" "] })).toEqual([
			["modules/0", "A module name is blank: name a module of the project."],
		]);
	});

	it("refuses an empty criteria list by name", () => {
		expect(faultsOf({ ...whole, criteria: [] })).toEqual([
			["criteria", "No criterion is designed: send one line per live criterion."],
		]);
	});

	it("never answers zod's own text for any of them", () => {
		const all = faultsOf({ criteria: [{ ...whole.criteria[0], proof: "" }], modules: [], contracts: [] });
		expect(all).toHaveLength(2);
		for (const [, message] of all) expect(message).not.toMatch(/Too small|expected/);
	});
});
