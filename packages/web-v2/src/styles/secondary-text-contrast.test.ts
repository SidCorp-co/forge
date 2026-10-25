// Secondary text is read, so it meets WCAG AA's 4.5:1 on every surface the app paints. ISS-1229 r38,
// judge-103 measured the --fg-subtle grey at 3.97-4.14:1 at 12px; it was 3.45:1 on --bg-active.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNER_TONE } from "@/design/primitives/banner";
import { AVATAR_HUE, TONE_META } from "@/design/status";

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

// ISS-1229 r39, judge-107 at 7d4a69d: the secondary token passed, and text set in other colours did not —
// placeholders and zero counts in the disabled grey (2.52-2.63:1), white on the flame accent (3.37:1),
// the amber attention banner (3.08:1) and amber avatar initials (3.12:1).
const ink = (value: string) => literal(/^var\((--[a-z0-9-]+)\)$/.exec(value)?.[1] ?? value);
const PAGE = ["--bg-surface", "--bg-app"];

describe("text the design system sets in a colour of its own", () => {
  it("reads white on the accent at 4.5:1 or more, at rest, hovered and pressed", () => {
    for (const bg of ["--accent", "--accent-hover", "--accent-press"]) {
      const ratio = contrast(literal("--fg-on-accent"), literal(bg));
      expect(ratio, `--fg-on-accent on ${bg} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each([
    ...Object.entries(TONE_META).map(([k, t]) => [`chip ${k}`, t.fg, t.bg] as const),
    ...Object.entries(BANNER_TONE).map(([k, t]) => [`banner ${k}`, t.fg, t.bg] as const),
    ...Object.entries(AVATAR_HUE).map(([k, t]) => [`avatar ${k}`, t.fg, t.bg] as const),
  ])("reads the %s text at 4.5:1 or more on its own tint and on the page", (_name, fg, bg) => {
    for (const under of [ink(bg), ...PAGE.map(literal)]) {
      const ratio = contrast(ink(fg), under);
      expect(ratio, `${fg} on ${under} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("fails the values it replaced", () => {
    expect(contrast("#FFFFFF", "#F15A2B")).toBeLessThan(AA);
    expect(contrast("#FFFFFF", "#DC4A1D")).toBeLessThan(AA);
    expect(contrast("#C6790A", "#FDF2DD")).toBeLessThan(AA);
    expect(contrast("#168256", "#E8F5EF")).toBeLessThan(AA);
    expect(contrast(literal("--fg-disabled"), literal("--bg-surface"))).toBeLessThan(AA);
  });
});

/** Every source file under src, tests aside. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** The disabled grey's uses that are an icon or a disabled control, which WCAG 1.4.3 leaves out. */
const ICON_USES = new Map([["design/patterns/data-table.tsx", "the unsorted column's sort arrow"]]);

describe("the disabled grey", () => {
  it("sets no placeholder and no text a person reads", () => {
    const root = join(__dirname, "..");
    const found = sources(root).flatMap((path) => {
      const text = readFileSync(path, "utf8");
      const file = relative(root, path);
      return [
        ...(/placeholder:text-disabled/.test(text) ? [`${file}: placeholder in the disabled grey`] : []),
        ...(/\btext-disabled\b/.test(text) && !ICON_USES.has(file) ? [`${file}: text in the disabled grey`] : []),
      ];
    });
    expect(found).toEqual([]);
  });
});

describe("text on the accent beside a type class", () => {
  it("uses .fg-on-accent, since a .fg-* class swallows the text-on-accent utility", () => {
    const root = join(__dirname, "..");
    const swallowed = sources(root).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
        .map((m) => (m[1] ?? m[2]) as string)
        .filter((cls) => /(^|\s)fg-(?!on-accent|danger)[a-z0-9-]+/.test(cls) && /(^|[\s"'])text-on-accent\b/.test(cls))
        .map((cls) => `${relative(root, path)}: "${cls}"`),
    );
    expect(swallowed).toEqual([]);
  });
});
