// ISS-1119 — `cn("text-13", "text-muted")` emitted `text-muted`, so the element
// rendered at the inherited 15px: the code said one size and the screen showed
// another, at 15 call sites, with nothing to report the gap.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TEXT_RAMP_STEPS, cn } from "./cn";

describe("cn over this repo's type ramp", () => {
	it("keeps a size and a colour that are not in conflict, whichever is written first", () => {
		expect(cn("text-13 text-fg")).toBe("text-13 text-fg");
		expect(cn("text-fg text-13")).toBe("text-fg text-13");
		expect(cn("text-9-5 font-semibold", "text-muted")).toBe("text-9-5 font-semibold text-muted");
	});

	it("still collapses one size onto another, because that IS a conflict", () => {
		expect(cn("text-13 text-15")).toBe("text-15");
		expect(cn("text-13", "text-9-5")).toBe("text-9-5");
	});

	it("still collapses one colour onto another", () => {
		expect(cn("text-muted text-fg")).toBe("text-fg");
	});

	it("leaves classes Tailwind ships with alone", () => {
		expect(cn("text-sm text-red-500")).toBe("text-sm text-red-500");
		expect(cn("text-sm text-lg")).toBe("text-lg");
	});

	it("collapses a ramp step against a stock size, because they are one group", () => {
		expect(cn("text-xs text-13")).toBe("text-13");
		expect(cn("text-13 text-xs")).toBe("text-xs");
	});

	it("leaves an arbitrary size to the classifier that already handled it", () => {
		expect(cn("text-[13px] text-fg")).toBe("text-[13px] text-fg");
		expect(cn("text-13 text-[13px]")).toBe("text-[13px]");
	});

	it("lets a caller's className override the size a component declared", () => {
		expect(cn("font-mono text-11 text-muted", "text-13")).toBe("font-mono text-muted text-13");
	});
});

// The ramp has one home, `@theme` in globals.css, and this binds the second reader to
// it: a step added there and not to cn turns this red rather than going quiet again.
describe("the ramp cn knows and the ramp globals.css declares", () => {
	function declaredSteps(): string[] {
		const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
		const open = css.indexOf("@theme {");
		const theme = css.slice(open, css.indexOf("\n}", open));
		return [...theme.matchAll(/^\s*--text-([0-9-]+):/gm)].map((m) => m[1]);
	}

	it("finds the ramp where it is declared, so this test cannot pass by finding nothing", () => {
		expect(declaredSteps().length).toBeGreaterThan(10);
	});

	it("are the same set", () => {
		expect([...TEXT_RAMP_STEPS].sort()).toEqual(declaredSteps().sort());
	});
});
