// ISS-1264: the owner's rule is flat sections with hairline dividers and no card mosaic; a Card stacked
// again in the Overview fails here by name.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const COMPONENTS = resolve(process.cwd(), "src/features/overview/components");

const SECTIONS = ["liveness-band", "work-sitting", "action-queue", "flow-section", "quality-section"];

const source = (name: string) => readFileSync(resolve(COMPONENTS, `${name}.tsx`), "utf8");

describe("the Overview's five sections are flat", () => {
  it.each(SECTIONS)("%s stacks no Card", (name) => {
    expect(source(name)).not.toMatch(/<Card[\s>]|<CardContent|<CardHeader/);
  });

  it.each(SECTIONS)("%s draws a hairline over its section and boxes nothing", (name) => {
    const text = source(name);
    expect(text).toMatch(/<section[^>]*border-t border-line/);
    expect(text).not.toMatch(/rounded-lg border|shadow-sm|bg-surface/);
  });

  it("owns five sections, one for each file", () => {
    const sections = SECTIONS.reduce((total, name) => total + (source(name).match(/<section[\s>]/g) ?? []).length, 0);
    expect(sections).toBeGreaterThanOrEqual(SECTIONS.length);
  });
});
