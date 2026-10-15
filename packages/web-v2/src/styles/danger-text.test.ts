// An error said at a type class's size must read as an error. `.fg-*` type classes are unlayered
// and Tailwind's utilities sit in `@layer utilities`, so `text-danger` beside a `.fg-*` is
// swallowed whatever its specificity (the ISS-1033 note in tokens.css): eleven error lines rendered
// grey that way. The colour is `.fg-danger`, a type-layer rule that wins by source order.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
/** tokens.css without its comments, which name `@layer` in prose. */
const TOKENS = readFileSync(join(__dirname, "tokens.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `.fg-…` rule in tokens.css that sets a colour, with where it starts. */
function colouringTypeRules(css: string): { name: string; at: number }[] {
  const rules: { name: string; at: number }[] = [];
  for (const m of css.matchAll(/^\.(fg-[a-z0-9-]+)\s*\{([^}]*)\}/gm)) {
    if (/(^|;)\s*color\s*:/.test(m[2] ?? "")) rules.push({ name: m[1] as string, at: m.index ?? 0 });
  }
  return rules;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

describe("an error at a type class's size", () => {
  it("has a type-layer danger colour that comes after every type class that sets one", () => {
    const rules = colouringTypeRules(TOKENS);
    const danger = rules.find((r) => r.name === "fg-danger");
    expect(danger, ".fg-danger is not in tokens.css, so an error caption has no danger colour").toBeDefined();
    expect(TOKENS).toMatch(/^\.fg-danger\s*\{[^}]*color\s*:\s*var\(--red-\d+\)/m);
    const later = rules.filter((r) => r.name !== "fg-danger" && r.at > (danger?.at ?? 0)).map((r) => r.name);
    expect(later, "a type class after .fg-danger would win by source order and turn its errors grey").toEqual([]);
    expect(TOKENS, "tokens.css is unlayered; a @layer here would change which rule wins").not.toMatch(/@layer/);
  });

  it("is never coloured by the text-danger utility, which a type class swallows", () => {
    const swallowed = sourceFiles(SRC).flatMap((file) => {
      const text = readFileSync(file, "utf8");
      return [...text.matchAll(/className="([^"]*)"/g)]
        .map((m) => m[1] as string)
        .filter((cls) => /(^|\s)fg-[a-z0-9-]+/.test(cls) && /(^|\s)text-danger(\s|$)/.test(cls))
        .map((cls) => `${file.slice(SRC.length + 1)}: "${cls}"`);
    });
    expect(swallowed, "use fg-danger beside a .fg-* class; text-danger there renders grey").toEqual([]);
  });
});
