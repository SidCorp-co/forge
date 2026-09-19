import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Which files a token layer is made of: one opening `@import "tailwindcss"` declares
 * the framework's default theme too, and a rule reading the file alone calls every
 * one of those tokens missing, then judges the classes naming them against that.
 */

const COMMENT = /\/\*[\s\S]*?\*\//g;
const IMPORT = /@import\s+(?:url\(\s*)?["']([^"']+)["']/g;

function pickStyle(entry) {
  if (typeof entry === "string") return entry.endsWith(".css") ? entry : null;
  if (entry === null || typeof entry !== "object") return null;
  for (const key of ["style", "default", "import", "require"]) {
    const found = pickStyle(entry[key]);
    if (found !== null) return found;
  }
  return null;
}

/** Found on disk, never through `exports`, which need not expose `./package.json`. */
function findManifest(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) return manifest;
    if (dir === path.dirname(dir)) return null;
  }
}

function resolveStylesheet(specifier, from) {
  if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
    const target = path.resolve(path.dirname(from), specifier);
    return existsSync(target) ? target : null;
  }
  const scoped = specifier.startsWith("@") ? 2 : 1;
  const segments = specifier.split("/");
  const name = segments.slice(0, scoped).join("/");
  const subpath = segments.slice(scoped).join("/");
  const manifest = findManifest(name, path.dirname(from));
  if (manifest === null) return null;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const entry = pkg.exports?.[subpath === "" ? "." : `./${subpath}`];
  const style = pickStyle(entry) ?? (subpath === "" ? pkg.style : `./${subpath}`);
  if (typeof style !== "string") return null;
  const target = path.resolve(path.dirname(manifest), style);
  return existsSync(target) ? target : null;
}

export function importedStylesheets(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const found = [];
  for (const match of readFileSync(file, "utf8").replace(COMMENT, "").matchAll(IMPORT)) {
    const target = resolveStylesheet(match[1].replace(/\s.*$/, ""), file);
    if (target === null || seen.has(target)) continue;
    found.push(...importedStylesheets(target, seen), { file: target });
  }
  return found;
}

/** For whether a token *exists*, never for what a layer *declares*. */
export function withImportedSources(sources) {
  return sources.flatMap(({ file, block, tokenPattern }) => [
    ...importedStylesheets(file).map((one) => ({ ...one, tokenPattern })),
    { file, block, tokenPattern },
  ]);
}
