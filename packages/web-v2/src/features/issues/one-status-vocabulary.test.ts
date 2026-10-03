// Two negatives no import graph can express, so this walks the files the way
// `no-status-ladder.test.ts` does: the lane word must not be reachable under an
// unqualified status-label name, and a second kernel-status-to-word map must not appear.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ISSUE_STATUSES } from "./types";

const SRC = resolve(__dirname, "../..");
const THIS_FILE = relative(SRC, __filename);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if ([".ts", ".tsx"].includes(extname(entry))) out.push(full);
  }
  return out;
}

const FILES = sourceFiles(SRC)
  .map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }))
  .filter((f) => f.path !== THIS_FILE);

it("walks a tree that is actually there", () => {
  expect(FILES.length).toBeGreaterThan(200);
});

describe("the lane word is not reachable under a status-label name", () => {
  const AMBIGUOUS = /^(?:use)?[Ss]tatus[Ll]abel/;
  const KERNEL_NAMED = new Set(["statusLabel", "STATUS_LABELS"]);
  const DECLARED =
    /\b(?:export\s+)?(?:const|function|type|interface|class)\s+([A-Za-z_$][\w$]*)/g;

  it("declares no such name beyond the two that answer with the kernel status", () => {
    const found: string[] = [];
    for (const { path, text } of FILES) {
      for (const [, name] of text.matchAll(DECLARED)) {
        if (!AMBIGUOUS.test(name) || KERNEL_NAMED.has(name)) continue;
        found.push(`${path}: ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("names neither retired symbol in any file's code", () => {
    const RETIRED = /\b(?:statusLabelFor|useStatusLabeller|StatusLabeller)\b/;
    const found = FILES.filter(({ text }) =>
      text
        .split("\n")
        .some((line) => !line.trimStart().startsWith("//") && RETIRED.test(line)),
    ).map((f) => f.path);
    expect(found).toEqual([]);
  });
});

describe("exactly one kernel-status-to-word map", () => {
  const KEY_OF = new RegExp(`^\\s*(${ISSUE_STATUSES.join("|")})\\s*:\\s*["'\`]`, "u");
  const HOME = resolve(SRC, "../../contracts/src/issue-vocabulary.ts");
  // A DISPLAY-WORD map is total or nearly so, since a partial one shows raw enum values, so a second
  // one is a literal over a large majority of the ten statuses: eight of them.
  const MAJORITY = 8;
  // The one file keyed over every status that is not a word map: the badge legend's glyphs, a mark
  // per status, read beside `statusLabel`'s word and never instead of it.
  const NOT_A_WORD_MAP = new Set(["features/issues/status-glyphs.ts"]);

  const statusesIn = (text: string): Set<string> => {
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      const m = KEY_OF.exec(line);
      if (m) seen.add(m[1]);
    }
    return seen;
  };

  it("declares no second one anywhere in web-v2", () => {
    const found: string[] = [];
    for (const { path, text } of FILES) {
      // A test's expected-word fixture is a second opinion, not a second map.
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      if (NOT_A_WORD_MAP.has(path)) continue;
      const n = statusesIn(text).size;
      if (n >= MAJORITY) found.push(`${path}: ${n} kernel statuses keyed to words`);
    }
    expect(found).toEqual([]);
  });

  it("would see a second map in the glyph file, were it not named as the exception", () => {
    const glyphs = FILES.find((f) => NOT_A_WORD_MAP.has(f.path));
    expect(glyphs, "the exempted file is not in the tree").toBeDefined();
    expect(statusesIn(glyphs?.text ?? "").size).toBeGreaterThanOrEqual(MAJORITY);
  });

  it("finds the one that IS there, so the scan is not passing on a broken pattern", () => {
    const seen = statusesIn(readFileSync(HOME, "utf8"));
    expect([...seen].sort()).toEqual([...ISSUE_STATUSES].sort());
  });
});
