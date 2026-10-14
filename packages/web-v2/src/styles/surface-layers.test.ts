// The UI stands on two layers told apart by tone (tokens.css): a graphite base under the shell and its
// sidebar, and the content every page paints over it. The owner could not tell the two apart when they
// were 0.014 of lightness apart and tinted cream, then read the light grey base's text as washed out
// beside the content's; these hold the base dark in both themes, every neutral grey, and the text on
// either layer at WCAG AA.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");
const tokens = read("tokens.css");
const shellRoute = read("../routes/_workspace/route.tsx");
const navRail = read("../design/patterns/nav-rail.tsx");
const drawer = read("../features/shell/components/mobile-nav-drawer.tsx");

type Oklch = [number, number, number];

/** The declarations of the first rule whose selector list ends with `selector`. */
function block(selector: string): Map<string, string> {
  const start = tokens.indexOf(`${selector} {`);
  expect(start, `tokens.css declares ${selector}`).toBeGreaterThan(-1);
  const body = tokens.slice(start, tokens.indexOf("}", start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1] ?? "", (m[2] ?? "").trim()]));
}

// each theme's own block over the declarations both themes share (the --shell-* text and tints)
const shared = block("[data-theme]");
const THEMES = {
  light: new Map([...shared, ...block('[data-theme="light"]')]),
  dark: new Map([...shared, ...block('[data-theme="dark"]')]),
};
const layer = block('[data-layer="shell"]');

function resolve(theme: Map<string, string>, name: string): Oklch {
  let value = theme.get(name);
  for (let hops = 0; value?.startsWith("var(") && hops < 4; hops++) value = theme.get(value.slice(4, -1));
  const m = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value ?? "");
  if (!m) throw new Error(`${name} does not resolve to an oklch() colour in its theme block: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** WCAG relative luminance of an OKLCH colour, through linear sRGB. */
function luminance([L, C, h]: Oklch): number {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const [r = 0, g = 0, bl = 0] = rgb.map((x) => Math.min(1, Math.max(0, x)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
}
const contrast = (x: Oklch, y: Oklch) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
};

describe.each(Object.entries(THEMES))("the %s theme's background layers", (_, theme) => {
  it("keeps every neutral step grey: achromatic, or too faint and too cool to read as cream", () => {
    for (let step = 1; step <= 12; step++) {
      const [, C, h] = resolve(theme, `--neutral-${step}`);
      const warm = C > 0.003 && h >= 20 && h <= 120;
      expect({ step, C, h, warm }).toEqual({ step, C, h, warm: false });
      expect(C, `neutral-${step} chroma`).toBeLessThanOrEqual(0.015);
    }
  });

  it("parts the shell's base from the content by tone, and keeps the content one flat tone", () => {
    const shell = resolve(theme, "--bg-shell"), app = resolve(theme, "--bg-app"), surface = resolve(theme, "--bg-surface");
    expect(app[0] - shell[0], "the base sits below the content: lightness of --bg-app over --bg-shell").toBeGreaterThanOrEqual(0.08);
    expect(surface, "--bg-surface is the content's own tone").toEqual(app);
  });

  it("keeps the base's own tones grey, like the neutrals", () => {
    for (const name of ["--bg-shell", "--shell-control", "--shell-hover", "--shell-active", "--shell-line-subtle", "--shell-line", "--shell-line-strong", "--shell-fg", "--shell-fg-muted", "--shell-fg-subtle"]) {
      const [, C, h] = resolve(theme, name);
      expect({ name, C, h, warm: C > 0.003 && h >= 20 && h <= 120 }).toEqual({ name, C, h, warm: false });
      expect(C, `${name} chroma`).toBeLessThanOrEqual(0.015);
    }
  });

  it("reads text at AA on the content, and on a hovered or sunken row there", () => {
    for (const bg of ["--bg-app", "--neutral-3"]) {
      for (const fg of ["--neutral-11", "--neutral-12", "--accent-11", "--ok-11", "--warn-11", "--danger-11", "--info-11", "--muted-11", "--ai-11"]) {
        const ratio = Number(contrast(resolve(theme, fg), resolve(theme, bg)).toFixed(2));
        expect({ fg, bg, aa: ratio >= 4.5 }).toEqual({ fg, bg, aa: true });
      }
    }
  });

  it("reads the sidebar's text at AA on the base, its controls, a hovered or active row and the active tint", () => {
    for (const bg of ["--bg-shell", "--shell-control", "--shell-hover", "--shell-active", "--shell-accent-tint"]) {
      for (const fg of ["--shell-fg", "--shell-fg-muted", "--shell-fg-subtle", "--shell-accent-text"]) {
        if (bg === "--shell-accent-tint" && fg === "--shell-fg-subtle") continue; // an active row's text is fg or accent-text
        const ratio = Number(contrast(resolve(theme, fg), resolve(theme, bg)).toFixed(2));
        expect({ fg, bg, aa: ratio >= 4.5 }).toEqual({ fg, bg, aa: true });
      }
    }
    const chip = Number(contrast(resolve(theme, "--shell-chip-fg"), resolve(theme, "--shell-chip")).toFixed(2));
    expect({ chip, aa: chip >= 4.5 }).toEqual({ chip, aa: true });
  });
});

describe("the shell", () => {
  it("stands its frame and sidebar on the base and its main pane on the content", () => {
    expect(shellRoute).toMatch(/className="[^"]*\bbg-shell\b[^"]*" data-print="frame" data-shell/);
    expect(shellRoute).toMatch(/<main className="[^"]*\bbg-app\b/);
    expect(navRail).toMatch(/data-layer="shell"\s+className=\{cn\(\s+"flex h-full flex-none flex-col border-r border-line bg-shell"/);
  });

  it("stands the phone's nav drawer on the same base layer as the sidebar", () => {
    expect(drawer).toMatch(/data-layer="shell" className="[^"]*\bbg-shell\b[^"]*\btext-fg\b/);
  });

  it("points every alias the sidebar draws with at the base's palette, in one rule", () => {
    expect(tokens.match(/\[data-layer="shell"\]\s*\{/g)?.length, "one [data-layer=\"shell\"] rule").toBe(1);
    const wanted: Record<string, string> = {
      "--bg-surface": "--shell-control", "--bg-sunken": "--shell-control", "--bg-hover": "--shell-hover", "--bg-active": "--shell-active",
      "--border-subtle": "--shell-line-subtle", "--border-default": "--shell-line", "--border-strong": "--shell-line-strong",
      "--fg-default": "--shell-fg", "--fg-muted": "--shell-fg-muted", "--fg-subtle": "--shell-fg-subtle",
      "--accent-tint": "--shell-accent-tint", "--accent-text": "--shell-accent-text",
    };
    for (const [alias, target] of Object.entries(wanted)) expect({ alias, value: layer.get(alias) }).toEqual({ alias, value: `var(${target})` });
  });
});
