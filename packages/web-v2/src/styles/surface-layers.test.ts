// The UI stands on two layers told apart by tone (tokens.css): a graphite base under the shell and its
// sidebar, and the content every page paints over it. The owner could not tell the two apart when they
// were 0.014 of lightness apart and tinted cream, then read the light grey base's text as washed out
// beside the content's; these hold the base dark in both themes, every neutral grey, and the text on
// either layer at WCAG AA. tokens.css is read as the cascade reads it: a theme's element takes every
// rule its selectors match in source order, and the shell layer's element takes its own rules over the
// values it inherits, so a token the layer does not re-declare keeps the theme's computed colour.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(import.meta.dirname, p), "utf8");
const tokens = read("tokens.css");
const shellRoute = read("../routes/_workspace/route.tsx");
const navRail = read("../design/patterns/nav-rail.tsx");
const drawer = read("../features/shell/components/mobile-nav-drawer.tsx");

type Oklch = [number, number, number];
const LAYER = '[data-layer="shell"]';

/** Every rule of tokens.css, in source order: its selector list and its custom-property declarations. */
const RULES = [...tokens.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: (m[1] ?? "").split(",").map((s) => s.trim()),
  decls: [...(m[2] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((d) => [d[1] ?? "", (d[2] ?? "").trim()] as const),
}));

/** An element's own declarations (later rules win) over what it inherits from its parent. */
interface Scope { own: Map<string, string>; parent?: Scope }
function scopeOf(matches: (selector: string) => boolean, parent?: Scope): Scope {
  const own = new Map<string, string>();
  for (const rule of RULES) if (rule.selectors.some(matches)) for (const [name, value] of rule.decls) own.set(name, value);
  return { own, parent };
}

function value(scope: Scope, name: string): Oklch {
  const raw = scope.own.get(name);
  if (raw === undefined) {
    if (!scope.parent) throw new Error(`${name} is not declared for this element or any it inherits from`);
    return value(scope.parent, name);
  }
  return parse(scope, raw, name);
}

/** An oklch() literal, a var() read on the same element, or color-mix(in oklch, A p%, B). */
function parse(scope: Scope, raw: string, name: string): Oklch {
  const lit = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(raw);
  if (lit) return [Number(lit[1]), Number(lit[2]), Number(lit[3])];
  const ref = /^var\((--[\w-]+)\)$/.exec(raw);
  if (ref) return value(scope, ref[1] ?? "");
  const mix = /^color-mix\(in oklch, (.+) ([\d.]+)%, (.+)\)$/.exec(raw);
  if (mix) {
    const a = parse(scope, mix[1] ?? "", name), b = parse(scope, mix[3] ?? "", name), p = Number(mix[2]) / 100;
    return [a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p)];
  }
  throw new Error(`${name} does not resolve to an oklch() colour: ${raw}`);
}

const themeOf = (theme: "light" | "dark") =>
  scopeOf((s) => s === ":root" || s === "[data-theme]" || s === `[data-theme="${theme}"]`);
const THEMES = { light: themeOf("light"), dark: themeOf("dark") };
const shellIn = (theme: Scope) => scopeOf((s) => s === LAYER, theme);

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
  return Number((((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05)).toFixed(2));
};
const grey = (name: string, [, C, h]: Oklch) => ({ name, warm: C > 0.003 && h >= 20 && h <= 120, faint: C <= 0.015 });

describe.each(Object.entries(THEMES))("the %s theme's background layers", (_, theme) => {
  const shell = shellIn(theme);

  it("keeps every neutral step grey: achromatic, or too faint and too cool to read as cream", () => {
    for (let step = 1; step <= 12; step++) {
      const name = `--neutral-${step}`;
      expect(grey(name, value(theme, name))).toEqual({ name, warm: false, faint: true });
    }
  });

  it("parts the shell's base from the content by tone, and keeps the content one flat tone", () => {
    const base = value(theme, "--bg-shell"), app = value(theme, "--bg-app");
    expect(app[0] - base[0], "the base sits below the content: lightness of --bg-app over --bg-shell").toBeGreaterThanOrEqual(0.08);
    expect(value(theme, "--bg-surface"), "--bg-surface is the content's own tone").toEqual(app);
  });

  it("keeps the base's own neutral steps grey, like the theme's", () => {
    for (let step = 1; step <= 12; step++) {
      const name = `--neutral-${step}`;
      expect(grey(name, value(shell, name))).toEqual({ name, warm: false, faint: true });
    }
  });

  it("reads text at AA on the content, and on a hovered or sunken row there", () => {
    for (const bg of ["--bg-app", "--neutral-3"]) {
      for (const fg of ["--neutral-11", "--neutral-12", "--accent-11", "--ok-11", "--warn-11", "--danger-11", "--info-11", "--muted-11", "--ai-11"]) {
        const ratio = contrast(value(theme, fg), value(theme, bg));
        expect({ fg, bg, aa: ratio >= 4.5 }).toEqual({ fg, bg, aa: true });
      }
    }
  });

  it("reads the sidebar's text at AA on the base, its controls, a hovered or active row and the active tint", () => {
    for (const bg of ["--bg-shell", "--bg-surface", "--bg-sunken", "--bg-hover", "--bg-active", "--accent-tint"]) {
      for (const fg of ["--fg-default", "--fg-muted", "--fg-subtle", "--accent-text", "--link"]) {
        if (bg === "--accent-tint" && (fg === "--fg-subtle" || fg === "--link")) continue; // an active row's text is fg or accent-text
        const ratio = contrast(value(shell, fg), value(shell, bg));
        expect({ fg, bg, aa: ratio >= 4.5 }).toEqual({ fg, bg, aa: true });
      }
    }
    for (const chip of ["--cobalt-50", "--cobalt-100"]) {
      const ratio = contrast(value(shell, "--cobalt-700"), value(shell, chip));
      expect({ chip, aa: ratio >= 4.5 }).toEqual({ chip, aa: true });
    }
  });

  it("re-resolves the old names and aliases built from a scale step on the layer, so they read on the base", () => {
    for (const fg of ["--ink-900", "--ink-700", "--ink-600", "--ink-550"]) {
      const ratio = contrast(value(shell, fg), value(shell, "--bg-shell"));
      expect({ fg, aa: ratio >= 4.5 }).toEqual({ fg, aa: true });
    }
    expect(value(shell, "--paper-0"), "--paper-0 is the base itself").toEqual(value(theme, "--bg-shell"));
    expect(value(shell, "--fg-disabled"), "--fg-disabled is the base's strong line").toEqual(value(theme, "--shell-line-strong"));
    // a status read on the layer takes the base's own text step, through the alias that names it
    for (const tone of ["ok", "warn", "danger", "info", "muted"]) {
      expect({ tone, fg: value(shell, `--status-${tone}-fg`) }).toEqual({ tone, fg: value(theme, `--shell-${tone}-11`) });
    }
  });

  it("reads every status text at 4.6:1 or more on the base, a hovered row and an active row", () => {
    const fgs = ["--status-ok-fg", "--status-warn-fg", "--status-danger-fg", "--status-info-fg", "--status-muted-fg", "--ai-fg", "--fg-danger", "--green-600", "--red-600", "--amber-600", "--slate-600"];
    for (const bg of ["--bg-shell", "--bg-hover", "--bg-active"]) {
      for (const fg of fgs) {
        const ratio = contrast(value(shell, fg), value(shell, bg));
        expect({ fg, bg, ratio, clear: ratio >= 4.6 }).toEqual({ fg, bg, ratio, clear: true });
      }
    }
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

  it("scopes the layer as a theme is scoped: the dark scales, the aliases, and one rule of its own", () => {
    const carries = (...selectors: string[]) => RULES.filter((r) => selectors.every((s) => r.selectors.includes(s))).length;
    expect(carries('[data-theme="dark"]', LAYER), "the dark scales also scope the layer").toBe(1);
    expect(carries("[data-theme]", LAYER), "the alias block re-resolves on the layer").toBe(1);
    expect(RULES.filter((r) => r.selectors.length === 1 && r.selectors[0] === LAYER).length, "one rule of the layer's own").toBe(1);
  });

  it("draws the sidebar in the base's palette, in both themes", () => {
    const wanted: Record<string, string> = {
      "--bg-shell": "--bg-shell", "--bg-surface": "--shell-control", "--bg-sunken": "--shell-control", "--bg-hover": "--shell-hover", "--bg-active": "--shell-active",
      "--border-subtle": "--shell-line-subtle", "--border-default": "--shell-line", "--border-strong": "--shell-line-strong",
      "--fg-default": "--shell-fg", "--fg-muted": "--shell-fg-muted", "--fg-subtle": "--shell-fg-subtle",
      "--accent-tint": "--shell-accent-tint", "--accent-text": "--shell-accent-text",
    };
    for (const theme of Object.values(THEMES)) {
      const shell = shellIn(theme);
      for (const [alias, token] of Object.entries(wanted)) expect({ alias, is: value(shell, alias) }).toEqual({ alias, is: value(theme, token) });
    }
  });
});
