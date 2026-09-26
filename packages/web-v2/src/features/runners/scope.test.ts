/**
 * ISS-1162 criteria 9, 12, 13, 14, 18 and 19. The page's claims about its own
 * population are read here, where a sentence can be made to go red without a
 * rendered screen standing in the way of the assertion.
 */

import { describe, expect, it } from "vitest";
import {
	assignmentBridgeLine,
	emptyState,
	populationLine,
	rowActionNote,
	scopeCountLabel,
	scopeName,
	UNKNOWN_COUNT,
} from "./scope";

describe("the count beside a scope", () => {
	it("says what it is counting", () => {
		expect(scopeCountLabel(40)).toBe("40 devices");
		expect(scopeCountLabel(1)).toBe("1 device");
	});

	it("reads as not yet counted rather than as zero while the query is in flight", () => {
		const label = scopeCountLabel(UNKNOWN_COUNT);
		expect(label).toBe("counting…");
		expect(label).not.toContain("0");
	});

	it("says zero only when zero is the answer", () => {
		expect(scopeCountLabel(0)).toBe("0 devices");
	});
});

describe("the population sentence", () => {
	it("names the own scope as the caller's own, unassigned boxes included", () => {
		expect(populationLine("mine")).toContain("you have paired");
		expect(populationLine("mine")).toContain("serves no project");
	});

	it("names the org scope as the projects this caller can see, not the org whole", () => {
		const line = populationLine("org");
		expect(line).toContain("a project you can see in this organisation");
		expect(line).toContain("whoever paired it");
	});

	it("gives the two scopes two different sentences", () => {
		expect(populationLine("mine")).not.toBe(populationLine("org"));
		expect(scopeName("mine")).toBe("Mine");
		expect(scopeName("org")).toBe("Organisation");
	});
});

describe("the line reconciling devices with the Overview's runners", () => {
	it("names both figures and says which one Overview counts", () => {
		const line = assignmentBridgeLine(12, 40);
		expect(line).toContain("These 12 devices");
		expect(line).toContain("40 runner assignments");
		expect(line).toContain("Overview counts");
	});

	it("reads singular for one device and one assignment", () => {
		expect(assignmentBridgeLine(1, 1)).toContain("This 1 device serves 1 runner assignment");
	});

	it("is withheld while either figure is unknown", () => {
		expect(assignmentBridgeLine(UNKNOWN_COUNT, 40)).toBeNull();
		expect(assignmentBridgeLine(12, UNKNOWN_COUNT)).toBeNull();
	});

	it("is withheld where there is no device to say it about", () => {
		expect(assignmentBridgeLine(0, 0)).toBeNull();
	});
});

describe("what stands in for the owner's controls on the org list", () => {
	it("withholds nothing on the caller's own list", () => {
		expect(rowActionNote("mine", true)).toBeNull();
	});

	it("says a row is read only where another member paired it", () => {
		expect(rowActionNote("org", false)).toBe("read only");
	});

	it("points a caller at the list where their own box always appears", () => {
		expect(rowActionNote("org", true)).toContain("Mine");
	});
});

describe("an empty own-scope list", () => {
	it("says the caller has paired nothing and quotes the organisation's count", () => {
		const state = emptyState("mine", { mine: 0, org: 40 });
		expect(state.title).toBe("You have not paired any machines");
		expect(state.message).toContain("40 devices");
		expect(state.message).toContain("Organisation scope");
	});

	it("quotes no organisation figure while that query has not answered", () => {
		const state = emptyState("mine", { mine: 0, org: UNKNOWN_COUNT });
		expect(state.message).not.toMatch(/\d/);
		expect(state.message).not.toContain("counting");
	});

	it("says so plainly when the organisation really does run none", () => {
		const state = emptyState("mine", { mine: 0, org: 0 });
		expect(state.message).toContain("No device is assigned to a project you can see");
	});
});

describe("an empty organisation-scope list", () => {
	it("never claims the organisation whole, only what this caller can see", () => {
		const state = emptyState("org", { mine: 3, org: 0 });
		expect(state.title).toBe(
			"No device is assigned to a project you can see in this organisation",
		);
		expect(state.title).not.toBe("No devices yet");
	});

	it("points a caller who has paired boxes at the assignment they have not made", () => {
		const state = emptyState("org", { mine: 3, org: 0 });
		expect(state.message).toContain("3 devices");
		expect(state.message).toContain("Assign one to a project");
	});

	it("quotes no own figure while that query has not answered", () => {
		const state = emptyState("org", { mine: UNKNOWN_COUNT, org: 0 });
		expect(state.message).not.toMatch(/\d/);
	});
});
