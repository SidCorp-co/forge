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
const bodyOf = (slug: string) => HELP_DOCS.find((d) => d.slug === slug)?.body ?? "";

/** Every page written for someone connecting an assistant, wherever it sits: the step rule is the
 *  `assistant-setup` audience's (docs/modules/guides/where-a-page-lives.md), not this folder's. */
const ASSISTANT_PAGES = HELP_DOCS.filter((d) => d.audience === "assistant-setup").map((d) => d.slug);

/**
 * Priced amnesty (ISS-1178): pages held to the step rule by audience that do not meet it yet. Each
 * reader here reaches a numbered step with nothing to check it against. Rewriting page content was
 * outside ISS-1178, so the page is named rather than passed; it ends when the page meets the rule,
 * and the test below refuses the entry from then on. Recorded in
 * docs/proposals/documentation-home-residuals.md.
 */
const STEP_RULE_EXEMPT: Record<string, string> = {
  [`${FOLDER}/when-it-does-not-work`]: "its three fix procedures have nine numbered steps and no Check line",
};

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

/** The paragraphs of a step that tell the reader to do something: everything before its Check. */
function instructionsOf(step: string): string {
  const paragraphs = step.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (/^\*\*Check:\*\*/.test(paragraphs.at(-1) ?? "")) paragraphs.pop();
  return paragraphs.join(" ").replace(/^\d+\.\s+/, "");
}

/** What a sentence says once the labels the reader's screen shows, and the text they type, are out of it. */
function plainWords(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*[^*\n]+\*\*/g, "X")
    .replace(/\*[^*\n]+\*/g, "X")
    .replace(/`[^`\n]+`/g, "X")
    .replace(/\s+/g, " ")
    .trim();
}

const ACT =
  "Choose|Type|Paste|Copy|Open|Press|Select|Tick|Replace|Save|Quit|Go|Click|Download|Install|Add|Delete|Ask|Run|Close|Sign|Pick|Start|Allow|Look|Follow|Restart|Keep|Leave|Turn|Give|Work|Use|Move|Wait";

/** A sentence that begins an act, once a leading "If …," condition is set aside. */
function startsAnAct(sentence: string): boolean {
  return new RegExp(`^(?:${ACT})\\b`, "i").test(sentence.replace(/^(?:If|When|Once)\b[^,]*,\s*/, ""));
}

/** The sentences of a paragraph, as the reader meets them. */
function sentencesOf(text: string): string[] {
  return plainWords(text)
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const JOINS_TWO_ACTS =
  /,\s*then\b|\bthen\s+(?:choose|type|paste|copy|open|press|select|tick|save|go|sign|click|replace|delete|follow)\b|\band\s+(?:choose|paste|copy|tick|open|save|select|click|replace|restart|download|install|delete|sign|follow|quit|pick|add|ask|run|close|start|allow|turn|give)\b/i;

/**
 * What makes one numbered step ask for more than one thing. Bounded on purpose: it holds the wordings a
 * bundled step took (a second sentence that starts an act, ", then", "and paste"). A sentence that
 * begins "On a Mac" or "On Windows" starts no act of its own: the reader does only one of the pair.
 */
function bundledActs(step: string): string[] {
  const reasons: string[] = [];
  const text = instructionsOf(step);
  const sentences = sentencesOf(text);
  const acts = sentences.filter((s) => startsAnAct(s));
  if (acts.length > 1) reasons.push(`${acts.length} sentences start an act: ${sentences.join(" | ")}`);
  const joined = JOINS_TWO_ACTS.exec(plainWords(text));
  if (joined) reasons.push(`one sentence joins two acts at "${joined[0]}"`);
  return reasons;
}

/** A Check says what the reader sees; an act inside it is one the step did not ask for. */
function checkAsksForAnAct(step: string): string[] {
  const paragraphs = step.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const check = paragraphs.at(-1) ?? "";
  if (!/^\*\*Check:\*\*/.test(check)) return [];
  return sentencesOf(check.replace(/^\*\*Check:\*\*\s*/, ""))
    .map((s) => s.replace(/^\(/, ""))
    .filter((s) => startsAnAct(s));
}

/** Every "step N" the page says, with the sentence it stands in: the numbers move when a step is added. */
function stepReferences(markdown: string): Array<{ number: number; sentence: string }> {
  const refs: Array<{ number: number; sentence: string }> = [];
  for (const sentence of sentencesOf(prose(markdown).replace(/^---[\s\S]*?^---/m, ""))) {
    for (const m of sentence.matchAll(/\b[Ss]teps? (\d+)(?:(?: and | to |, )(\d+))?/g)) {
      refs.push({ number: Number(m[1]), sentence });
      if (m[2]) refs.push({ number: Number(m[2]), sentence });
    }
  }
  return refs;
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

  it.each(SETUP_PAGES)("%s has numbered steps", (page) => {
    expect(mainSteps(body(page)).length).toBeGreaterThan(3);
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

describe("the assistant-setup step rule, over every page of that audience", () => {
  it("covers the setup pages and every other page behind the assistant door", () => {
    for (const page of SETUP_PAGES) expect(ASSISTANT_PAGES).toContain(`${FOLDER}/${page}`);
  });

  it.each(ASSISTANT_PAGES.filter((slug) => !(slug in STEP_RULE_EXEMPT)))(
    "%s ends each numbered step in what the reader should now see",
    (slug) => {
      expect(stepsWithoutACheck(bodyOf(slug))).toEqual([]);
    },
  );

  it.each(Object.entries(STEP_RULE_EXEMPT))("%s stays exempt only while it still fails (%s)", (slug) => {
    expect(ASSISTANT_PAGES).toContain(slug);
    expect(stepsWithoutACheck(bodyOf(slug)).length, `${slug} now meets the step rule: remove it from STEP_RULE_EXEMPT`).toBeGreaterThan(0);
  });
});

describe("one action to a step, on the four setup pages", () => {
  it.each(SETUP_PAGES)("%s asks for one action in each numbered step", (page) => {
    const bundled = numberedSteps(body(page))
      .map((step) => ({ step: step.split("\n")[0], reasons: bundledActs(step) }))
      .filter((s) => s.reasons.length > 0);
    expect(bundled).toEqual([]);
  });

  it.each(SETUP_PAGES)("%s keeps every act out of a Check line", (page) => {
    const asked = numberedSteps(body(page))
      .map((step) => ({ step: step.split("\n")[0], acts: checkAsksForAnAct(step) }))
      .filter((s) => s.acts.length > 0);
    expect(asked).toEqual([]);
  });

  it.each(SETUP_PAGES)("%s sends every 'step N' it mentions to a step that exists", (page) => {
    const count = mainSteps(body(page)).length;
    const dangling = stepReferences(body(page)).filter((r) => r.number < 1 || r.number > count);
    expect(dangling).toEqual([]);
  });

  // A number that still resolves can point at the wrong step after a renumbering, so the
  // references that name what they point at are held to that.
  it.each(SETUP_PAGES)("%s sends each 'step N' that names a thing to the step holding it", (page) => {
    const steps = mainSteps(body(page));
    const named: Array<[RegExp, RegExp]> = [
      [/\bthe project you chose in step/, /Bind to a project/],
      [/\bthe code (?:in your note )?from step/, /forge_pat_/],
      [/\bthe Endpoint from step/, /\*\*Endpoint\*\*/],
      [/\bstep \d+ below says how/, /terminal/i],
    ];
    const wrong: string[] = [];
    for (const ref of stepReferences(body(page))) {
      for (const [phrase, holds] of named) {
        if (phrase.test(ref.sentence) && !holds.test(steps[ref.number - 1] ?? "")) {
          wrong.push(`step ${ref.number} is not the one that holds ${holds}: ${ref.sentence}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  // The form shows read ticked when it opens (tokens-tab.tsx: useState<PatScope[]>(["read"])), so a
  // step telling the reader to tick both has them click read and clear it.
  it.each(SETUP_PAGES)("%s tells the reader to tick write, and that read is already ticked", (page) => {
    const scopes = mainSteps(body(page)).find((s) => /\*\*Scopes\*\*/.test(s)) ?? "";
    const instruction = instructionsOf(scopes);
    expect(instruction).toMatch(/tick \*\*write\*\*/);
    expect(instruction).toMatch(/\*\*read\*\* is already ticked/);
    expect(instruction).not.toMatch(/tick both/i);
    expect(scopes).toMatch(/\*\*Check:\*\* both \*\*read\*\* and \*\*write\*\* are ticked\./);
  });

  it.each(SETUP_PAGES)("%s gives the password box and the sign-in provider a Check of their own", (page) => {
    const text = body(page);
    expect(text).toMatch(/^## If Forge asks you to confirm it is you$/m);
    const section = /^## If Forge asks you to confirm it is you\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
    const steps = numberedSteps(section);
    expect(steps.length).toBeGreaterThanOrEqual(5);
    expect(stepsWithoutACheck(section)).toEqual([]);
    expect(section).toMatch(/\*\*Confirm password\*\*/);
    expect(section).toMatch(/\*\*Confirm & create\*\*/);
    expect(section).toMatch(/\*\*Continue with\*\*/);
  });
});

describe("the one-action rule, each against the step it would let through", () => {
  it.each([
    ["Choose **Create token**, then type your password.", true],
    ["Copy the code and paste it into your note.", true],
    ["Choose **Copy to clipboard**. Paste the code into your note.", true],
    ["Go to `https://nodejs.org` and download the installer.", true],
    ["Add a new one and pick its kind.", true],
    ["Save, and restart the app if it asks you to.", true],
    ["Under **Scopes**, tick **write**; **read** is already ticked for you. Read lets the assistant look things up.", false],
    ["Open Claude Desktop's settings. On a Mac, choose **Claude** › **Settings…**. On Windows, choose **☰** › **File** › **Settings…**.", false],
    ["Replace `<YOUR_TOKEN_HERE>` with the code from step 10, keeping the word `Bearer`.", false],
    ["If the window is empty, select everything in it.", false],
  ])("%s", (instruction, bundles) => {
    const step = `1. ${instruction}\n\n   **Check:** something shows.`;
    expect(bundledActs(step).length > 0).toBe(bundles);
  });

  it("refuses an act inside a Check, and lets a sentence about what the screen shows through", () => {
    expect(checkAsksForAnAct("1. Open it.\n\n   **Check:** it is listed. If a switch is off, turn it on.")).toHaveLength(1);
    expect(checkAsksForAnAct("1. Open it.\n\n   **Check:** it is listed. Go back to step 16.")).toHaveLength(1);
    expect(checkAsksForAnAct("1. Open it.\n\n   **Check:** it is listed with a green dot.")).toEqual([]);
  });

  it("reads a step number, a pair of them and a range, and ignores prose that has none", () => {
    const page = "Do it as in step 4. Steps 5 and 6 say how. Skip steps 7 to 9. Nothing here.";
    expect(stepReferences(page).map((r) => r.number)).toEqual([4, 5, 6, 7, 9]);
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
    expect(desktop()).toMatch(/followed by other connections[\s\S]*Type a comma/);
    expect(desktop()).toMatch(/with nothing between the braces[\s\S]*no comma after it/);
    expect(desktop()).toMatch(/no `"mcpServers"` at all[\s\S]*Type `},`/);
    expect(fragment().endsWith("}")).toBe(true);
  });
});
