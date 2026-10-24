// Secondary text is read, so it meets WCAG AA's 4.5:1 on every surface the app paints. ISS-1229 r38,
// judge-103 measured the --fg-subtle grey at 3.97-4.14:1 at 12px; it was 3.45:1 on --bg-active.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const VARS = new Map(
  [...TOKENS.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/g)].map((m) => [m[1] as string, (m[2] as string).trim()]),
);

/** Follow a `var(--x)` chain to the colour it ends at. */
function literal(name: string): string {
  let value = `var(${name})`;
  for (let hop = 0; hop < 12; hop += 1) {
    const m = /^var\((--[a-z0-9-]+)\)$/.exec(value);
    if (!m) return value;
    const next = VARS.get(m[1] as string);
    if (next === undefined) throw new Error(`tokens.css declares no ${m[1]}`);
    value = next;
  }
  throw new Error(`var() chain from ${name} did not end`);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = ["--bg-surface", "--bg-app", "--bg-sunken", "--bg-hover", "--bg-active"];
const AA = 4.5;

describe("secondary text", () => {
  it.each(["--fg-muted", "--fg-subtle"])("%s reads at 4.5:1 or more on every surface", (fg) => {
    for (const bg of SURFACES) {
      const ratio = contrast(literal(fg), literal(bg));
      expect(ratio, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("measures a pair it can be checked against by hand, and fails the grey it replaced", () => {
    expect(Number(contrast("#000000", "#FFFFFF").toFixed(2))).toBe(21);
    expect(Number(contrast("#767D8A", "#FFFFFF").toFixed(2))).toBe(4.14);
    expect(contrast("#767D8A", literal("--bg-active"))).toBeLessThan(AA);
  });
});
