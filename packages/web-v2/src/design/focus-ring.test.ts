// web-v2 spends one CSS budget on two jobs: `box-shadow` carries BOTH elevation and the keyboard
// focus ring, and `outline` is suppressed app-wide. globals.css puts the default ring in
// `@layer base`, so any element that declares an elevation `shadow-*` utility silently overrides
// it — utilities beat base — and keeps its shadow while losing its ring. Measured on /kit
// 2026-09-05 (ISS-843): SegmentedControl's active segment and ProjectCard's <Link> were exactly
// that, invisible to keyboard users across all 47 tab stops on the page.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// cm:guard Keyboard focus must stay VISIBLE on every interactive element (ux-contract §4); these two assertions are the only thing standing between an added `shadow-*` and a control no keyboard user can locate, so neither may be relaxed to make a new component pass — give the component its ring instead.

const DESIGN_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = resolve(DESIGN_DIR, "..");
const GLOBALS_CSS = join(SRC_DIR, "app", "globals.css");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

/** The opening tag of every `<button>` / `<a>` / `<Link>`, braces and strings balanced. */
function interactiveOpeningTags(source: string): string[] {
  const tags: string[] = [];
  for (const m of source.matchAll(/<(?:button|a|Link)(?=[\s/>])/g)) {
    let depth = 0;
    let quote: string | null = null;
    for (let i = m.index; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{" || c === "(") depth++;
      else if (c === "}" || c === ")") depth--;
      else if (c === ">" && depth === 0) {
        tags.push(source.slice(m.index, i));
        break;
      }
    }
  }
  return tags;
}

/** An elevation shadow applied unconditionally — no `focus-visible:` / `hover:` variant. */
const ELEVATION = /(?<![\w:[-])shadow-(?:xs|sm|md|lg|xl|\[var\(--shadow-(?:xs|sm|md|lg|xl)\)\])/;

/** Offsets of every `:focus-visible {` selector in the sheet. */
function focusVisibleRules(css: string): number[] {
  return [...css.matchAll(/(?<![\w-]):focus-visible\s*\{/g)].map((m) => m.index);
}

/** The `[open, close]` span of the `@layer base { … }` block. */
function layerBaseSpan(css: string): [number, number] {
  const open = css.indexOf("@layer base {");
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return [open, i];
  }
  return [open, css.length];
}

describe("keyboard focus ring", () => {
  it("globals.css keeps the default ring, inside @layer base and nowhere else", () => {
    const css = readFileSync(GLOBALS_CSS, "utf8");
    const [open, close] = layerBaseSpan(css);
    expect(open).toBeGreaterThan(-1);

    // cm:guard Delete this rule and every control that does not declare its own ring goes ringless; move it OUT of `@layer base` and it beats every per-component ring instead (flame accent, bare inputs), which is why the span is checked and not just the presence.
    expect(css.slice(open, close)).toMatch(
      /:focus-visible\s*\{[^}]*box-shadow:\s*var\(--shadow-focus\)/,
    );
    const strays = focusVisibleRules(css).filter((i) => i < open || i > close);
    expect(strays.map((i) => `line ${css.slice(0, i).split("\n").length}`)).toEqual([]);
  });

  it("no interactive element trades its focus ring for an elevation shadow", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      for (const tag of interactiveOpeningTags(readFileSync(file, "utf8"))) {
        if (!ELEVATION.test(tag)) continue;
        if (tag.includes("focus-visible:shadow-")) continue;
        offenders.push(
          `${file.slice(SRC_DIR.length + 1)}: ${tag.replace(/\s+/g, " ").slice(0, 120)}`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
