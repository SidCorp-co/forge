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
  /,\s*then\b|\bthen\s+(?:choose|type|paste|copy|open|press|select|tick|save|go|sign|click|replace|delete|follow)\b|\band\s+(?:choose|paste|copy|tick|open|save|select|click|replace|restart|download|install|delete|sign|follow|quit|pick|add|ask|run|close|start|allow|turn|give|press)\b/i;

/**
 * "Replace X with Y" where Y sits somewhere else is four acts by these pages' own copy rule: highlight Y,
 * copy it, highlight X, paste. A step asking it in one leaves the most exacting selection with no Check.
 */
const REPLACES_FROM_ELSEWHERE = /\breplace\b[^.]*\bwith\b/i;
const PLACEHOLDER = /`<[A-Z_]+>`/g;
/** "Steps 1 to 10" inside one step is ten acts the reader does behind that step's single Check. */
const RUNS_A_RANGE = /\bsteps \d+ (?:to|through|and) \d+\b/i;

/**
 * What makes one numbered step ask for more than one thing. Bounded on purpose: it holds the wordings a
 * bundled step took (a second sentence that starts an act, ", then", "and paste", "and press", a replace
 * from elsewhere, two placeholders, a range of steps). A sentence that begins "On a Mac" or "On Windows"
 * starts no act of its own: the reader does only one of the pair.
 */
function bundledActs(step: string): string[] {
  const reasons: string[] = [];
  const text = instructionsOf(step);
  const sentences = sentencesOf(text);
  const acts = sentences.filter((s) => startsAnAct(s));
  if (acts.length > 1) reasons.push(`${acts.length} sentences start an act: ${sentences.join(" | ")}`);
  const joined = JOINS_TWO_ACTS.exec(plainWords(text));
  if (joined) reasons.push(`one sentence joins two acts at "${joined[0]}"`);
  if (REPLACES_FROM_ELSEWHERE.test(plainWords(text))) {
    reasons.push("a replace from elsewhere is four acts: highlight the value, copy it, highlight the placeholder, paste");
  }
  const placeholders = text.match(PLACEHOLDER) ?? [];
  if (placeholders.length > 1) reasons.push(`${placeholders.length} placeholders in one step: ${placeholders.join(", ")}`);
  const range = RUNS_A_RANGE.exec(plainWords(text));
  if (range) reasons.push(`one step runs "${range[0]}"`);
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

/** Prose as one line, frontmatter, headings and bold marks gone: what a reference is read in. */
function flat(markdown: string): string {
  return prose(markdown)
    .replace(/^---[\s\S]*?^---/m, "")
    .replace(/^#+ .*$/gm, "")
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ");
}

type SetupPage = (typeof SETUP_PAGES)[number];

/**
 * Every way these pages name a step, each with what the step it names has to hold. `says` captures
 * the number, and a second number where it names a range, whose last step `end` is read against.
 * Each points into the page saying it: a step of another page is not a step this reader is on.
 */
interface ReferenceForm {
  says: RegExp;
  holds: RegExp;
  end?: RegExp;
}

const REFERENCE_FORMS: ReferenceForm[] = [
  { says: /the project you chose in step (\d+)/, holds: /Bind to a project/ },
  { says: /the Endpoint from step (\d+)/, holds: /\*\*Endpoint\*\*/ },
  { says: /\(steps (\d+) to (\d+) below says? how\)/, holds: /open your computer's search/, end: /to open the terminal/ },
  { says: /After step (\d+) you see/, holds: /^\d+\. Choose \*\*Create token\*\*\./ },
  { says: /(?:You come back to step (\d+) when the panel is showing|you go on to step (\d+)\. If you see a Confirm password)/, holds: /^\d+\. Choose \*\*Copy to clipboard\*\*/ },
  { says: /You come back to step (\d+) when Developer is in the list/, holds: /^\d+\. Choose \*\*Developer\*\*/ },
  { says: /Developer is now in the list on the left\. Now go back to step (\d+)/, holds: /^\d+\. Choose \*\*Developer\*\*/ },
  { says: /You come back to step (\d+) when the window shows the file/, holds: /^\d+\. Open the file/ },
  { says: /claude_desktop_config\.json`\. Now go back to step (\d+)/, holds: /^\d+\. Open the file/ },
  { says: /when you opened the file in step (\d+)/, holds: /^\d+\. Open the file/ },
  { says: /You go on to step (\d+) when you have finished it/, holds: /^\d+\. (?:In your note, drag across the address|Save)/ },
  { says: /Now go on to step (\d+)\./, holds: /^\d+\. Save\./ },
  { says: /settings again, the same way as in step (\d+)/, holds: /^\d+\. Open Claude Desktop's settings\./ },
  { says: /Open Settings again, as in step (\d+)/, holds: /^\d+\. Open Claude Desktop's settings\./ },
  { says: /on each screen, as in step (\d+)/, holds: /^\d+\. On each installer screen/ },
  { says: /the same connection as in step (\d+)/, holds: /\*\*Copy\*\* above the block/ },
  { says: /(?:the block you copied in step|If you copied the block in step) (\d+)/, holds: /\*\*Copy\*\* above the block|to copy the block\./ },
  { says: /If step (\d+) shows `✘/, holds: /✔ Connected/ },
  { says: /If step (\d+) does not show forge as running/, holds: /marked \*\*running\*\*/ },
  { says: /If step (\d+) shows no forge/, holds: /\*\*Check:\*\* \*\*forge\*\* is listed\./ },
  { says: /or step (\d+) shows a red dot/, holds: /green dot/ },
  { says: /lists connected services, as in step (\d+)/, holds: /^\d+\. In your app, open the place where it lists connected services/ },
];

/**
 * The step references a page makes, each read through the form it is written in. `wrong` is a
 * reference whose step does not hold what it names; `unread` is one written in no known form, which
 * a renumbering could move with nothing to say it went wrong.
 */
function unresolvedReferences(page: SetupPage): { wrong: string[]; unread: string[] } {
  const text = flat(body(page));
  const read = new Set<number>();
  const wrong: string[] = [];
  for (const form of REFERENCE_FORMS) {
    const steps = mainSteps(body(page));
    for (const m of text.matchAll(new RegExp(form.says.source, "g"))) {
      const numbers = m.slice(1).filter((n) => n !== undefined).map(Number);
      numbers.forEach((n, i) => {
        const holds = i > 0 && form.end ? form.end : form.holds;
        if (!holds.test(steps[n - 1] ?? "")) wrong.push(`step ${n} does not hold ${holds}: ${m[0]}`);
      });
      for (const r of m[0].matchAll(/\b[Ss]teps? \d+/g)) read.add((m.index ?? 0) + (r.index ?? 0));
    }
  }
  const unread = [...text.matchAll(/\b[Ss]teps? \d+/g)]
    .filter((r) => !read.has(r.index ?? -1))
    .map((r) => text.slice(Math.max(0, (r.index ?? 0) - 60), (r.index ?? 0) + 20));
  return { wrong, unread };
}

/**
 * A step that sends the reader into a section names the step they come back to, and the section's
 * own last line names one too. Two numbers for one return leave the reader at whichever they read last.
 */
function disagreeingReturns(markdown: string): string[] {
  const out: string[] = [];
  for (const step of mainSteps(markdown)) {
    const sent = /follow (.+?) at the end of this page\. You (?:come back|go on) to step (\d+)/.exec(flat(step));
    if (!sent) continue;
    const [, title, back] = sent;
    const heading = markdown.split("\n").find((l) => l.startsWith("## ") && l.slice(3) === title);
    if (!heading) {
      out.push(`no section titled ${title}`);
      continue;
    }
    const section = markdown.slice(markdown.indexOf(heading) + heading.length).split(/^## /m)[0];
    for (const r of flat(section).matchAll(/(?:go back|go on) to step (\d+)/g)) {
      if (r[1] !== back) out.push(`${title}: the step says ${back}, the section says ${r[1]}`);
    }
  }
  return out;
}

/** What a reader types or sees by name: each `code` span and **label**, the quote marks round it set aside. */
function literalsIn(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*/g)].map((m) => (m[1] ?? m[2]).replace(/^"(.*)"$/, "$1"));
}

/** A literal standing as a whole name in `text`: `forge` in `"forge": {`, not in `forge_pat_`. */
function namesLiteral(text: string, literal: string): boolean {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text);
}

const SENDS = /follow \*\*(.+?)\*\* at the end of this page\. You (?:come back|go on) to step (\d+)/;

/**
 * Every path a section opens, and what it leaves out. A step sending the reader to a section stands in a
 * run of "If …" steps the reader picks one of, so the path skips the rest of that run, and every step
 * between the sender and the step the section returns to. A Check after the return that names something
 * only a skipped step typed or showed relies on a step this reader never took, unless the section, or a
 * step before the run, gives it to them too.
 */
function pathsMissingAStep(markdown: string): string[] {
  const steps = mainSteps(markdown);
  const conditional = (i: number) => /^If\b/.test(instructionsOf(steps[i] ?? ""));
  const out: string[] = [];
  steps.forEach((step, sender) => {
    const sent = SENDS.exec(instructionsOf(step).replace(/\s+/g, " "));
    if (!sent) return;
    const [, title, back] = sent;
    const returnTo = Number(back) - 1;
    let first = sender;
    while (first > 0 && conditional(first - 1)) first--;
    let last = sender;
    while (last + 1 < steps.length && conditional(last + 1)) last++;
    const skipped = new Set<number>();
    for (let i = first; i <= Math.max(last, returnTo - 1); i++) if (i !== sender && i < returnTo) skipped.add(i);
    const heading = markdown.split("\n").find((l) => l === `## ${title}`);
    const section = heading ? markdown.slice(markdown.indexOf(heading)).split(/^## /m)[1] ?? "" : "";
    const given = [section, ...steps.slice(0, first)].join("\n");
    const onlySkipped = new Set([...skipped].flatMap((i) => literalsIn(prose(steps[i]))));
    for (let i = returnTo; i < steps.length; i++) {
      const paragraphs = steps[i].split(/\n\s*\n/).map((p) => p.trim());
      const check = paragraphs.at(-1) ?? "";
      for (const literal of literalsIn(check)) {
        if (!onlySkipped.has(literal) || namesLiteral(given, literal)) continue;
        if (steps.slice(returnTo, i).some((s) => namesLiteral(s, literal))) continue;
        out.push(`${title}: step ${i + 1}'s Check names ${literal}, which only a step it skips gives`);
      }
    }
  });
  return [...new Set(out)];
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

  it.each(SETUP_PAGES)("%s resolves every 'step N' it says to the step holding what it names", (page) => {
    expect(unresolvedReferences(page)).toEqual({ wrong: [], unread: [] });
  });

  it.each(SETUP_PAGES)("%s returns the reader from a section to the step that sent them there", (page) => {
    expect(disagreeingReturns(body(page))).toEqual([]);
  });

  it.each(SETUP_PAGES)("%s gives every path through a section what the Checks after it name", (page) => {
    expect(pathsMissingAStep(body(page))).toEqual([]);
  });

  it("reads each reference form on some page, so none of them is a rule nothing exercises", () => {
    const unused = REFERENCE_FORMS.filter((form) => !SETUP_PAGES.some((page) => form.says.test(flat(body(page)))));
    expect(unused.map((form) => form.says.source)).toEqual([]);
  });

  it("names no step of the four setup pages from any other help page", () => {
    const setupLink = new RegExp(`${FOLDER}/(?:${SETUP_PAGES.join("|")})\\b|Connect (?:Claude Desktop|Claude Code|Cursor|another app)`);
    const naming = HELP_DOCS.filter((d) => !SETUP_PAGES.some((p) => d.slug === `${FOLDER}/${p}`)).flatMap((d) =>
      flat(d.body)
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => setupLink.test(sentence) && /\b[Ss]teps? \d/.test(sentence))
        .map((sentence) => `${d.slug}: ${sentence}`),
    );
    expect(naming).toEqual([]);
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

  // tokens-tab.tsx starts the Permissions choice empty and refuses Create token until one is made, so
  // a page that skips it stops every reader at the create step with no Check that says why.
  it.each(SETUP_PAGES)("%s makes the Permissions choice the form requires, right after Scopes", (page) => {
    const steps = mainSteps(body(page));
    const at = (re: RegExp) => steps.findIndex((s) => re.test(instructionsOf(s)));
    const scopes = at(/^Under \*\*Scopes\*\*/);
    const pick = at(/^Under \*\*Permissions\*\*, choose \*\*Only the permissions I pick\*\*\./);
    const tick = at(/^Tick `issues:read`\./);
    const create = at(/^Choose \*\*Create token\*\*\./);
    expect(scopes).toBeGreaterThanOrEqual(0);
    expect([pick, tick]).toEqual([scopes + 1, scopes + 2]);
    expect(create).toBeGreaterThan(tick);
    expect(steps[tick]).toMatch(/\*\*Check:\*\* `issues:read` is the only permission ticked\./);
  });

  // The tab draws Your tokens first and Create a token below it (tokens-tab.tsx), even with no tokens.
  it.each(SETUP_PAGES)("%s finds the Create a token form below Your tokens, where the tab draws it", (page) => {
    const steps = mainSteps(body(page));
    const tab = steps.findIndex((s) => /^\d+\. Choose the \*\*API Tokens\*\* tab\./.test(s));
    expect(steps[tab]).toMatch(/\*\*Check:\*\* a list titled \*\*Your tokens\*\* is at the top of the tab\./);
    expect(instructionsOf(steps[tab + 1] ?? "")).toMatch(/below \*\*Your tokens\*\*, to the form titled \*\*Create a token\*\*/);
    expect(body(page)).not.toMatch(/\*\*Create a token\*\* is at the top/);
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
    ["Open a terminal. On a Mac, press **Cmd+Space**, type `Terminal` and press Enter.", true],
    ["Type `claude mcp list` and press Enter.", true],
    ["Press Enter to open the terminal.", false],
    ["Under **Scopes**, tick **write**; **read** is already ticked for you. Read lets the assistant look things up.", false],
    ["Open Claude Desktop's settings. On a Mac, choose **Claude** › **Settings…**. On Windows, choose **☰** › **File** › **Settings…**.", false],
    ["Replace `<YOUR_TOKEN_HERE>` with the code from step 10, keeping the word `Bearer`.", true],
    ["In the block, replace `<YOUR_TOKEN_HERE>` with your token, keeping the word `Bearer`.", true],
    ["Fill in `<ENDPOINT>` and `<PROJECT>` from your note.", true],
    ["Install **Node.js** by following steps 1 to 10 of [Connect Claude Desktop](?path=x).", true],
    ["In your note, drag across the code, from `forge_pat_` to its last character, to highlight it.", false],
    ["In the line, drag across `<YOUR_TOKEN_HERE>`, from `<` to `>`, to highlight it.", false],
    ["Press **Cmd+V** on a Mac, or **Ctrl+V** on Windows, to paste the code over it.", false],
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

  it("refuses a section that returns the reader to a step its caller does not name", () => {
    const page = [
      "## Steps",
      "",
      "1. Choose **Developer**.",
      "",
      "   **Check:** it opens.",
      "",
      "2. If it is missing, follow **If it is missing** at the end of this page. You come back to step 3 when it is there.",
      "",
      "   **Check:** it opens.",
      "",
      "## If it is missing",
      "",
      "Now go back to step 1.",
    ].join("\n");
    expect(disagreeingReturns(page)).toEqual(["If it is missing: the step says 3, the section says 1"]);
    expect(disagreeingReturns(page.replace("step 3 when", "step 1 when"))).toEqual([]);
  });

  it("refuses a section path that skips the step naming what a later Check looks for", () => {
    const page = [
      "## Steps",
      "",
      "1. Choose to add a service.",
      "",
      "   **Check:** the app asks for a name.",
      "",
      "2. If your app only starts programs, follow **If it starts programs** at the end of this page. You go on to step 4 when you have finished it.",
      "",
      "   **Check:** if you followed it, the app shows your settings.",
      "",
      "3. For the name, type `forge`.",
      "",
      "   **Check:** the name box shows `forge`.",
      "",
      "4. Save.",
      "",
      "   **Check:** **forge** is listed.",
      "",
      "## If it starts programs",
      "",
      "1. In the command box, type `npx`.",
      "",
      "   **Check:** the command box shows `npx`.",
      "",
      "Now go on to step 4.",
    ].join("\n");
    expect(pathsMissingAStep(page)).toEqual([
      "If it starts programs: step 4's Check names forge, which only a step it skips gives",
    ]);
    const named = page.replace(
      "Now go on to step 4.",
      "2. For the name, type `forge`.\n\n   **Check:** the name box shows `forge`.\n\nNow go on to step 4.",
    );
    expect(pathsMissingAStep(named)).toEqual([]);
    expect(pathsMissingAStep(page.replace("go on to step 4 when", "go on to step 3 when"))).toEqual([]);
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
