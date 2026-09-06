import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ISS-649's A->C invariant: the whole Operator Ops Console lives in this
 * directory and depends on `@forge/contracts` plus a thin local api wrapper,
 * so lifting it into its own app later costs a move and not a rewrite.
 *
 * `archmap` cannot hold this — its `web-features` module is every feature at
 * once, so a `features/operator` -> `features/issues` import is an edge WITHIN
 * one module and invisible to a boundary contract. This test is the only thing
 * that sees it.
 */
const ROOT = dirname(fileURLToPath(import.meta.url));

const ALLOWED_PREFIXES = [
  "@forge/contracts",
  "@/design",
  "@/lib/",
  "@/providers/",
  "next",
  "react",
  "@tanstack/react-query",
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...sources(p));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(p);
    }
  }
  return out;
}

const IMPORT = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g;

describe("features/operator is self-contained (ISS-649 A->C invariant)", () => {
  const files = sources(ROOT);

  it("has sources to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("imports no other feature module", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const spec = m[1] as string;
        if (spec.startsWith("@/features/") || spec.includes("../")) {
          if (!spec.startsWith("../") || spec.startsWith("../features/")) {
            offenders.push(`${relative(ROOT, file)} -> ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports nothing outside the declared dependency set", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const spec = m[1] as string;
        if (spec.startsWith(".")) continue;
        if (ALLOWED_PREFIXES.some((p) => spec === p || spec.startsWith(p))) continue;
        offenders.push(`${relative(ROOT, file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
