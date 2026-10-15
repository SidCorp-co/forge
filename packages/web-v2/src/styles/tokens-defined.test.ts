// Every `var(--name)` the web source paints with names a custom property something defines. A var
// nothing defines is not an error anywhere: the browser drops the declaration, so a fill reads as
// transparent and a colour as inherited, and no build, type check or lint says so (ISS-1228: the
// dashboard's costliest spend segment drew as empty track under `var(--fg)`, a name no token has).
//
// Defined means one of three: a declaration in a stylesheet under src (the tokens, the theme), a
// font variable next/font injects, or a `"--name":` key set inline in the same file that reads it.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const FONT_VARIABLE = /variable\s*:\s*["'](--[A-Za-z0-9_-]+)["']/g;

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path, pattern);
    return pattern.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path] : [];
  });
}

/** The text without its comments, which name properties in prose. A line comment only where it opens a line, so a URL survives. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every custom property a stylesheet declares, in any rule or at-rule. */
function declaredInCss(css: string): Set<string> {
  return new Set([...code(css).matchAll(/(?:^|[{;\s])(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1] as string));
}

/** The properties a source file sets for itself as inline style keys. */
function setInline(text: string): Set<string> {
  return new Set([...code(text).matchAll(/["'](--[A-Za-z0-9_-]+)["']\s*:/g)].map((m) => m[1] as string));
}

/** Every `var(--name` a file reads. A name built at runtime (`var(--x-${k})`) keeps its `${`, so it is refused rather than skipped. */
function readsVars(text: string): string[] {
  return [...code(text).matchAll(/var\(\s*(--[A-Za-z0-9_-]+(?:\$\{)?)/g)].map((m) => m[1] as string);
}

/** `file: --name` for each read nothing defines, given every source by path and what the stylesheets declare. */
function undefinedReads(sources: ReadonlyMap<string, string>, declared: ReadonlySet<string>): string[] {
  const fonts = new Set([...sources.values()].flatMap((t) => [...code(t).matchAll(FONT_VARIABLE)].map((m) => m[1] as string)));
  const out = new Set<string>();
  for (const [file, text] of sources) {
    const inline = setInline(text);
    for (const name of readsVars(text)) {
      if (declared.has(name) || fonts.has(name) || inline.has(name)) continue;
      out.add(`${file}: ${name.endsWith("${") ? `${name}…} (a name built at runtime cannot be checked)` : name}`);
    }
  }
  return [...out].sort();
}

describe("every var() the web source reads is defined", () => {
  it("names no custom property that no stylesheet, font or inline style defines", () => {
    const declared = new Set<string>();
    const sources = new Map<string, string>();
    for (const file of files(SRC, /\.css$/)) {
      const text = readFileSync(file, "utf8");
      for (const name of declaredInCss(text)) declared.add(name);
      sources.set(relative(SRC, file), text);
    }
    for (const file of files(SRC, /\.tsx?$/)) sources.set(relative(SRC, file), readFileSync(file, "utf8"));
    expect(declared.has("--fg-default"), "the token sheet was not read, so every var would pass").toBe(true);
    expect(sources.size, "no source was read, so nothing would be refused").toBeGreaterThan(100);
    expect(undefinedReads(sources, declared), "use a token styles/tokens.css or app/globals.css defines").toEqual([]);
  });

  it("refuses a var nothing defines, a near-miss of a real token included", () => {
    const sources = new Map([["a.ts", 'const INK = ["var(--fg)", "var(--fg-muted)"];']]);
    expect(undefinedReads(sources, new Set(["--fg-default", "--fg-muted"]))).toEqual(["a.ts: --fg"]);
  });

  it("accepts a property the same file sets inline, and a next/font variable from any file", () => {
    const sources = new Map([
      ["grid.tsx", 'const s = { "--sel": "2rem" }; const c = "grid-cols-[var(--sel)_1fr]";'],
      ["layout.tsx", 'const f = Font({ variable: "--font-hanken" });'],
      ["tokens.css", ":root { --font-sans: var(--font-hanken), sans-serif; }"],
    ]);
    expect(undefinedReads(sources, new Set(["--font-sans"]))).toEqual([]);
  });

  it("does not let one file's inline property define it for another", () => {
    const sources = new Map([
      ["a.tsx", 'const s = { "--w": "2rem" };'],
      ["b.tsx", 'const c = "w-[var(--w)]";'],
    ]);
    expect(undefinedReads(sources, new Set())).toEqual(["b.tsx: --w"]);
  });

  it("refuses a name built at runtime instead of skipping it", () => {
    const open = "$" + "{";
    const sources = new Map([["a.ts", `const c = \`var(--tone-${open}k})\`;`]]);
    expect(undefinedReads(sources, new Set(["--tone-red"]))).toEqual([
      `a.ts: --tone-${open}…} (a name built at runtime cannot be checked)`,
    ]);
  });

  it("reads declarations on one line and inside an at-rule, and ignores names in comments", () => {
    const css = "/* --ghost: 1 */ @theme { --color-fg: var(--fg-default); } .x{--a:1;--b: 2}";
    expect([...declaredInCss(css)].sort()).toEqual(["--a", "--b", "--color-fg"]);
    expect(readsVars("// var(--ghost)\nconst a = 'var(--real)';")).toEqual(["--real"]);
  });
});
