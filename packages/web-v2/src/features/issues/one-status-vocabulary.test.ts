// ISS-1097 — one rendering decision in one place, held by a scan of the tree.
//
// Two negatives that no import graph can express, so this walks the files the
// way `no-status-ladder.test.ts` does.
//
// 1. The lane word must not be reachable under an unqualified status-label
//    name. `statusLabelFor`/`useStatusLabeller` returned the nine-bucket lane
//    word, and four surfaces took the name at its word and reported a status
//    with it: the STATUS column, the detail header, the properties rail and the
//    post-transition toast. The rename to `laneLabel`/`useLaneLabeller` is the
//    fix; this case stops the old name coming back on the lane function.
// 2. A second kernel-status-to-word map must not appear. `STATUS_LABELS` is the
//    one, and the vocabulary that folds 17 onto 9 lives in `@forge/contracts`.

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
  // The unqualified names only. `pipelineStatusLabel` carries its own domain in
  // its name and is a different status vocabulary altogether — a name that says
  // which statuses it labels is not the name this defect was made of.
  const AMBIGUOUS = /^(?:use)?[Ss]tatus[Ll]abel/;
  // Both answer with the KERNEL status, which is what makes the name honest.
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
  const HOME = "features/issues/derive.ts";
  // A DISPLAY-WORD map has to be total or nearly so: `statusLabel` is called for whatever status a
  // row holds, and a partial table shows raw enum values on the rest. So a second one is a literal
  // over a large majority of the statuses. Twelve spares the two eight-status tables in
  // `features/skills/types.ts` and `lib/api/error.ts`, which map a status to the pipeline STEP it
  // dispatches: a different vocabulary about the same key, and a near-duplicate of each other
  // rather than of this map. `docs/proposals/two-copies-of-the-status-to-step-table.md` holds it.
  const MAJORITY = 12;

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
      // A test's own expected-word fixture is the deliberate second opinion this issue asked for:
      // `status-cell.test.tsx` spells all 17 words precisely so a wrong value in the production map
      // fails rather than being followed. It is not a rendering decision and is not a second map.
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      if (path === HOME) continue;
      const n = statusesIn(text).size;
      if (n >= MAJORITY) found.push(`${path}: ${n} kernel statuses keyed to words`);
    }
    expect(found).toEqual([]);
  });

  it("finds the one that IS there, so the scan is not passing on a broken pattern", () => {
    const home = FILES.find((f) => f.path === HOME);
    expect(home, `${HOME} was not walked`).toBeDefined();
    const seen = statusesIn((home as { text: string }).text);
    expect([...seen].sort()).toEqual([...ISSUE_STATUSES].sort());
  });
});
