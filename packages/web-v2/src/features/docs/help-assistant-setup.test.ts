/**
 * ISS-1175 — the pages that connect a person's own assistant to Forge. Their reader has never
 * heard the word "MCP", mistypes something at step 2, and does not know where a file lives, so
 * the rules below are the ones a script can hold: every step says what the reader should now see,
 * every file comes with how to open it, and nothing is promised the product does not do.
 */

import { describe, expect, it } from "vitest";
import { HELP_DOCS } from "./help-content.generated";

const FOLDER = "connect-an-assistant";
const SECTION = "Connect an assistant";
const PAGES = [
  "what-this-does",
  "claude-desktop",
  "claude-code",
  "cursor",
  "other-apps",
  "what-you-can-ask",
  "when-it-does-not-work",
] as const;
const SETUP_PAGES = ["claude-desktop", "claude-code", "cursor", "other-apps"] as const;
const EXPLAINS_MCP = "what-this-does";

const body = (page: string) => HELP_DOCS.find((d) => d.slug === `${FOLDER}/${page}`)?.body ?? "";

/** Prose only: fenced blocks hold what the reader pastes, not what the page says to them. */
function prose(markdown: string): string {
  return markdown.replace(/^[ \t]*```[\s\S]*?^[ \t]*```/gm, "");
}

/**
 * Every top-level numbered item on the page, fallback procedures included, each with everything
 * indented under it. A numbered list is a procedure wherever it sits, and its reader is as lost
 * at a missing checkpoint in a fallback as in the main steps.
 */
function numberedSteps(markdown: string): string[] {
  const items: string[] = [];
  let current: string[] | null = null;
  for (const line of prose(markdown).split("\n")) {
    if (/^\d+\. /.test(line)) {
      current = [line];
      items.push("");
    } else if (current && (line.trim() === "" || /^\s/.test(line))) {
      current.push(line);
    } else {
      current = null;
    }
    if (current) items[items.length - 1] = current.join("\n").trim();
  }
  return items;
}

/** The items of the page's `## Steps` section alone: the main path. */
function mainSteps(markdown: string): string[] {
  const steps = /^## Steps\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1] ?? "";
  return numberedSteps(steps);
}

/** A step whose last paragraph is not a `**Check:**` line leaves its reader guessing. */
function stepsWithoutACheck(markdown: string): string[] {
  return numberedSteps(markdown).filter((step) => {
    const paragraphs = step.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    return !/^\*\*Check:\*\*\s+\S/.test(paragraphs.at(-1) ?? "");
  });
}

/** "MCP" outside the page that explains it, and not quoting a label the reader's screen shows. */
function unquotedMcp(markdown: string): string[] {
  const outsideQuotes = prose(markdown).replace(/\*\*[^*\n]+\*\*/g, "").replace(/`[^`\n]+`/g, "");
  return outsideQuotes.match(/.{0,30}\bMCP\b.{0,30}/g) ?? [];
}

const FILE_NAMED = /[\w.-]+\.json\b/;

/** A page naming a file the reader must open also says how, on each of the two systems. */
function fileWithoutWhereToFindIt(markdown: string): boolean {
  if (!FILE_NAMED.test(prose(markdown))) return false;
  return !(/\bOn a Mac\b/.test(markdown) && /\bOn Windows\b/.test(markdown));
}

const SPELLED = "a|an|one|two|three|four|five|ten|fifteen|twenty|thirty|a few|\\d+";
const TIMING_PROMISE = new RegExp(
  `\\b(?:within|about|around|roughly|under|in)\\s+(?:${SPELLED})\\s+(?:seconds?|minutes?|hours?|days?|weeks?)\\b|` +
    "\\b\\d+\\s*(?:–|-|to)\\s*\\d+\\s+(?:seconds|minutes|hours|days)\\b|\\bshortly\\b|\\binstantly\\b|\\bafter a short (?:while|period)\\b",
  "i",
);
const TOOL_NAME = /\bforge_(?!pat_)[a-z_.]+\b/;
const CORRECTNESS_PROMISE =
  /\b(?:always|guarantee[sd]?|never wrong|100%)\b[^.\n]{0,60}\b(?:answer|right|correct|accurate)|\b(?:correct|accurate|right) (?:answer|result)s? every time\b/i;

/** The questions on the what-you-can-ask page: each item of its lists, as the reader copies it. */
function questions(markdown: string): string[] {
  return [...prose(markdown).matchAll(/^\s*(?:-|\d+\.)\s+"([^"\n]+)"\s*$/gm)].map((m) => m[1]);
}

/** The failures on the when-it-does-not-work page: one `##` section each. */
function failures(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((m) => m[1]).filter((h) => !/^Still stuck/i.test(h));
}

describe("the Connect an assistant section", () => {
  it.each(PAGES)("publishes %s in it", (page) => {
    const doc = HELP_DOCS.find((d) => d.slug === `${FOLDER}/${page}`);
    expect(doc?.section).toBe(SECTION);
  });

  it("holds those seven pages and no others", () => {
    const inSection = HELP_DOCS.filter((d) => d.section === SECTION).map((d) => d.slug).sort();
    expect(inSection).toEqual(PAGES.map((p) => `${FOLDER}/${p}`).sort());
  });

  it("says what connecting does before any setup step", () => {
    const text = body(EXPLAINS_MCP);
    expect(numberedSteps(text)).toEqual([]);
    expect(text).toMatch(/\bMCP\b/);
  });

  it.each(PAGES.filter((p) => p !== EXPLAINS_MCP))(
    "%s uses the word MCP only where it quotes a label",
    (page) => {
      expect(unquotedMcp(body(page))).toEqual([]);
    },
  );

  it.each(SETUP_PAGES)("%s has numbered steps, each ending in what the reader should now see", (page) => {
    expect(mainSteps(body(page)).length).toBeGreaterThan(3);
    expect(stepsWithoutACheck(body(page))).toEqual([]);
  });

  it.each(SETUP_PAGES)("%s says where to find every file it names, on a Mac and on Windows", (page) => {
    expect(fileWithoutWhereToFindIt(body(page))).toBe(false);
  });

  it("offers twenty questions to copy", () => {
    expect(questions(body("what-you-can-ask"))).toHaveLength(20);
  });

  it("names five failures, each with what the reader sees and the fix", () => {
    const text = body("when-it-does-not-work");
    const sections = text.split(/^## /m).slice(1).filter((s) => !/^Still stuck/i.test(s));
    expect(failures(text)).toHaveLength(5);
    for (const section of sections) {
      expect(section).toMatch(/\*\*What you see\*\*/);
      expect(section).toMatch(/\*\*The fix\*\*/);
    }
  });

  it.each(PAGES)("%s promises no timing, names no tool and claims no correctness", (page) => {
    const text = prose(body(page));
    expect(text).not.toMatch(TIMING_PROMISE);
    expect(body(page)).not.toMatch(TOOL_NAME);
    expect(text).not.toMatch(CORRECTNESS_PROMISE);
  });
});

describe("those rules, each against the page it would let through", () => {
  it("refuses a step with no Check line, and one whose Check is not its last word", () => {
    const page = [
      "## Steps",
      "",
      "1. Open the app.",
      "",
      "   **Check:** the app is open.",
      "2. Paste the line.",
      "3. Press Enter.",
      "",
      "   **Check:** the terminal prints a line.",
      "",
      "   Then do something else.",
      "",
      "## Next",
    ].join("\n");
    expect(stepsWithoutACheck(page).map((s) => s.slice(0, 2))).toEqual(["2.", "3."]);
  });

  it("refuses MCP in running prose and lets a quoted label through", () => {
    expect(unquotedMcp("Open your MCP settings.")).toHaveLength(1);
    expect(unquotedMcp("Choose the **MCP** tab, then run `claude mcp add`.")).toEqual([]);
  });

  it("refuses a file named without where to find it on both systems", () => {
    expect(fileWithoutWhereToFindIt("Open claude_desktop_config.json.")).toBe(true);
    expect(fileWithoutWhereToFindIt("Open mcp.json. On a Mac, press Cmd+Shift+J.")).toBe(true);
    expect(
      fileWithoutWhereToFindIt("Open mcp.json. On a Mac, press Cmd+Shift+J. On Windows, press Ctrl+Shift+J."),
    ).toBe(false);
  });

  it.each([
    ["It connects within 2 minutes.", TIMING_PROMISE],
    ["Your assistant answers instantly.", TIMING_PROMISE],
    ["About ten minutes, and permission to install software.", TIMING_PROMISE],
    ["It is ready in a few minutes.", TIMING_PROMISE],
    ["It calls forge_issues for you.", TOOL_NAME],
    ["Your assistant always gives the correct answer.", CORRECTNESS_PROMISE],
    ["You get accurate results every time.", CORRECTNESS_PROMISE],
  ])("refuses %s", (sentence, rule) => {
    expect(sentence).toMatch(rule);
  });

  it("counts a question only when it is a quoted list item", () => {
    const page = ['- "What is open?"', "- Not a question in quotes", '1. "Who holds ISS-4?"'].join("\n");
    expect(questions(page)).toEqual(["What is open?", "Who holds ISS-4?"]);
  });
});

// The Claude Desktop settings file also holds the app's own preferences, so the page adds Forge
// to it three ways. Each recipe, followed literally on the file it is for, has to leave JSON the
// app can read, with what was there kept.
describe("the Claude Desktop page's three ways into a file that already has text", () => {
  const desktop = () => body("claude-desktop");
  const fragment = () => {
    const section = desktop().slice(desktop().indexOf("## If the file already has text in it"));
    const block = /```json\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    return block
      .replaceAll("<ENDPOINT>", "https://forge.example/mcp")
      .replaceAll("<YOUR_TOKEN_HERE>", "forge_pat_prd_0")
      .replaceAll("<PROJECT>", "demo")
      .trim();
  };

  /** What the reader does: put `typed` straight after the first `anchor` in the file. */
  const typeAfter = (file: string, anchor: string, typed: string) => {
    const at = file.indexOf(anchor);
    if (at === -1) throw new Error(`the fixture has no ${anchor} to type after`);
    const end = at + anchor.length;
    return file.slice(0, end) + typed + file.slice(end);
  };

  const recipes: Array<[string, string, (file: string) => string]> = [
    [
      "other connections listed",
      '{\n  "mcpServers": {\n    "other": { "command": "x" }\n  },\n  "preferences": { "a": 1 }\n}',
      (f) => typeAfter(f, '"mcpServers": {', `\n${fragment()},`),
    ],
    [
      "an empty mcpServers",
      '{ "preferences": { "a": 1 }, "mcpServers": {} }',
      (f) => typeAfter(f, '"mcpServers": {', `\n${fragment()}\n`),
    ],
    [
      "no mcpServers at all",
      '{"preferences":{"a":1}}',
      (f) => typeAfter(f, "{", `\n"mcpServers": {\n${fragment()}\n},`),
    ],
  ];

  it.each(recipes)("leaves readable settings when the file has %s", (_case, file, recipe) => {
    const result = JSON.parse(recipe(file)) as {
      mcpServers: Record<string, { command: string; env: Record<string, string> }>;
      preferences: { a: number };
    };
    expect(result.mcpServers.forge?.command).toBe("npx");
    expect(result.mcpServers.forge?.env.FORGE_PROJECT).toBe("demo");
    expect(result.preferences).toEqual({ a: 1 });
  });

  it("names those three cases on the page, and pastes a block with no comma of its own", () => {
    expect(desktop()).toMatch(/followed by other connections[\s\S]*type a comma/);
    expect(desktop()).toMatch(/with nothing between the braces[\s\S]*Type no\s+comma/);
    expect(desktop()).toMatch(/no `"mcpServers"` at all[\s\S]*type `},`/);
    expect(fragment().endsWith("}")).toBe(true);
  });
});
