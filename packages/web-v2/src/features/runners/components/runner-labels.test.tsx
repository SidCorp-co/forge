import { describe, expect, it } from "vitest";
import { parseLabels } from "./runner-labels";

describe("parseLabels", () => {
	it("splits on commas and whitespace, trims, and drops duplicates and blanks", () => {
		expect(parseLabels(" release, gpu  release,, ")).toEqual(["release", "gpu"]);
	});

	it("reads an empty field as no labels, which is how a pool is cleared", () => {
		expect(parseLabels("   ")).toEqual([]);
	});
});
