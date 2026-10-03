// Every text token reads at WCAG AA (4.5:1) on every ground a page puts text on. --fg-subtle was
// ink-500 (#767D8A): 4.14:1 on white and 3.74:1 on --bg-sunken, so every label and caption drawn
// with `text-subtle` failed AA and read as faint. The values come from tokens.css itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

const VARS = new Map<string, string>();
for (const m of TOKENS.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/g)) if (!VARS.has(m[1])) VARS.set(m[1], m[2].trim());

function hex(token: string): string {
  let v = VARS.get(token);
  for (let hop = 0; v && hop < 12; hop += 1) {
    const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
    if (!ref) break;
    v = VARS.get(ref[1]);
  }
  if (!v || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`${token} does not resolve to a #rrggbb literal (got ${v})`);
  return v;
}

function luminance(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("text tokens on page grounds", () => {
  const texts = ["--fg-default", "--fg-muted", "--fg-subtle"];
  const grounds = ["--bg-surface", "--bg-app", "--bg-sunken"];
  for (const fg of texts)
    for (const bg of grounds)
      it(`${fg} on ${bg} is at least 4.5:1`, () => {
        expect(Number(contrast(hex(fg), hex(bg)).toFixed(2)), `${fg} ${hex(fg)} on ${bg} ${hex(bg)}`).toBeGreaterThanOrEqual(4.5);
      });

  it("measures a known pair", () => {
    expect(Number(contrast("#000000", "#FFFFFF").toFixed(2))).toBe(21);
  });
});
