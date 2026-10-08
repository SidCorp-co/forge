// Two negatives no import graph can express, so this walks the files the way
// `no-status-ladder.test.ts` does: the lane word must not be reachable under an
// unqualified status-label name, and a second kernel-status-to-word map must not appear.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OPEN_WORK_LABEL, WORK_STATE_LABELS, WORK_STATES } from "@forge/contracts/work-state";
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
  // The unqualified names only: `pipelineStatusLabel` says which statuses it labels.
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
  // one is a literal over a large majority of the statuses. Twelve spares the two eight-status tables
  // in `features/skills/types.ts` and `lib/api/error.ts`, which map a status to the pipeline STEP it
  // dispatches — another vocabulary; `docs/proposals/two-copies-of-the-status-to-step-table.md`.
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
      // A test's expected-word fixture is a second opinion, not a second map.
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      const n = statusesIn(text).size;
      if (n >= MAJORITY) found.push(`${path}: ${n} kernel statuses keyed to words`);
    }
    expect(found).toEqual([]);
  });

  it("finds the one that IS there, so the scan is not passing on a broken pattern", () => {
    const seen = statusesIn(readFileSync(HOME, "utf8"));
    expect([...seen].sort()).toEqual([...ISSUE_STATUSES].sort());
  });
});

describe("one work-state vocabulary (ISS-1156)", () => {
  const HOME = resolve(SRC, "../../contracts/src/work-state.ts");
  // Every word a screen reads from `@forge/contracts/work-state`, taken from its own list so a state
  // added there is guarded the day it is added. A literal of one anywhere else in web-v2 is a second
  // place to keep in step, which is how five screens came to five words.
  const WORDS = [...Object.values(WORK_STATE_LABELS), OPEN_WORK_LABEL];
  const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** A comment names a word without declaring it. */
  const withoutComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  /**
   * The words `text` declares: a whole quoted string, a whole JSX text node, or a JSX text node that
   * opens with a word of more than one word (a card titled "Open work by state" is the word plus
   * more, which is the word kept in a second file all the same).
   */
  const declaringAWord = (raw: string): string[] => {
    const text = withoutComments(raw);
    return WORDS.filter((w) => {
      const word = escapeRe(w);
      const quoted = new RegExp(`["'\`]${word}["'\`]`, "u");
      const textNode = new RegExp(`>\\s*${word}\\s*<`, "u");
      const textNodeOpening = new RegExp(`>\\s*${word}\\b[^<>{}]*[<{]`, "u");
      return quoted.test(text) || textNode.test(text) || (w.includes(" ") && textNodeOpening.test(text));
    });
  };

  it("takes every state's word and the open-work word, so none is hand-picked", () => {
    expect(WORDS).toEqual([...WORK_STATES.map((s) => WORK_STATE_LABELS[s]), OPEN_WORK_LABEL]);
    expect(WORDS.length).toBe(WORK_STATES.length + 1);
  });

  it("finds each word where it is declared, so the scan is not passing on a broken pattern", () => {
    const home = readFileSync(HOME, "utf8");
    expect(declaringAWord(home).sort()).toEqual([...WORDS].sort());
  });

  it.each(WORDS)("goes red on a file that declares %s itself, however it is written", (word) => {
    expect(declaringAWord(`const LABEL = "${word}";`)).toEqual([word]);
    expect(declaringAWord(`const x = '${word}';`)).toEqual([word]);
    expect(declaringAWord(`const x = \`${word}\`;`)).toEqual([word]);
    expect(declaringAWord(`<CardTitle>${word}</CardTitle>`)).toEqual([word]);
    expect(declaringAWord(`<StreamBand outboundLabel="${word}" />`)).toEqual([word]);
  });

  it.each(WORDS.filter((w) => w.includes(" ")))(
    "goes red on a JSX text node that opens with %s and carries on",
    (word) => {
      expect(declaringAWord(`<CardTitle>${word} by state</CardTitle>`)).toEqual([word]);
    },
  );

  it("leaves a word named in a comment, and a word inside a longer string, alone", () => {
    for (const word of WORDS) {
      expect(declaringAWord(`// the "${word}" segment`)).toEqual([]);
      expect(declaringAWord(`/* the '${word}' segment\n   goes here */`)).toEqual([]);
    }
    expect(declaringAWord(`const m = "Draft saved";`)).toEqual([]);
  });

  it("declares none of the words in any other source file", () => {
    const found: string[] = [];
    for (const { path, text } of FILES) {
      if (path.endsWith(".test.ts") || path.endsWith(".test.tsx")) continue;
      // The generated help bundle is prose a person wrote, not a label this tree keeps.
      if (path.endsWith("help-content.generated.ts")) continue;
      for (const word of declaringAWord(text)) found.push(`${path}: "${word}"`);
    }
    expect(found).toEqual([]);
  });

  it("writes no issue status as Queued, Running or Needs a human in the tables that name a status", () => {
    const BANNED = /["'`](Queued|Running|Needs a human)["'`]/u;
    const TABLES = ["features/project-settings/types.ts", "lib/api/error.ts", "features/issues/derive.ts"];
    for (const table of TABLES) {
      const text = FILES.find((f) => f.path === table)?.text ?? "";
      expect(text.length, `${table} was read`).toBeGreaterThan(0);
      expect([table, BANNED.test(text)]).toEqual([table, false]);
    }
  });
});
