// ISS-1229 r34, judge-93: a room's tool cards read "Object · 3 fields", and a filing the tracker refused
// once then accepted left a bare "forge — Failed". The shapes below are the ones judge-93 read back off
// a room on beta 61b8876, and judge-95's off beta 2b0f8aa (r35).

import { describe, expect, it } from "vitest";
import { decodeToolOutput } from "@/features/session/result-summary";
import type { ToolCallData } from "@/features/session/types";
import { DONE_AT_A_TERMINAL, ROOM_KNOWLEDGE_READS, ROOM_VERBS, whereItIsDone } from "@forge/contracts/room-verbs";
import { DOOR_OF_TOOL, PUT_IT_RIGHT, refusalReason, TOOK_ANOTHER_WAY, toolWords } from "./tool-words";

const cli = (argv: string[], out: { exitCode: number; stdout: string; stderr: string }, body = ""): ToolCallData => ({
  id: "t1",
  name: "forge",
  input: { argv, body },
  result: decodeToolOutput(JSON.stringify(out)),
  ...(out.exitCode === 0 ? {} : { isError: true }),
});
const none = { exitCode: 0, stdout: "\n0 issue(s) over 1 page(s), which is every row matching this ask.\n", stderr: "" };

describe("what a room's assistant did, in words", () => {
  it("says a search of the issues, its words and how many it found", () => {
    expect(toolWords(cli(["issue", "--search", "invoice footer"], none))).toEqual({
      said: "Searched issues for “invoice footer” — none found",
    });
    const one = { ...none, stdout: "ISS-1    none     open         J93 judge test\n\n1 issue(s) over 1 page(s)\n" };
    expect(toolWords(cli(["issue", "--search", "invoice footer"], one)).said).toBe(
      "Searched issues for “invoice footer” — 1 found",
    );
  });

  it("names a status by its label when listing the issues at it", () => {
    expect(toolWords(cli(["issue", "--status", "needs_info", "--limit", "20"], none)).said).toBe(
      "Listed issues at Needs info — none found",
    );
  });

  it("says which issue it filed, by key and title, off the tracker's reply", () => {
    const filed = {
      exitCode: 0,
      stdout: 'Nothing open reads like this filing — the check ran and found none.\n{\n  "documentId": "5a18d4cf",\n  "issueId": "ISS-1",\n  "id": "5a18d4cf"\n}\n',
      stderr: "",
    };
    expect(toolWords(cli(["new", "-", "--title", "J93 judge test: invoice footer typo", "--category", "bug"], filed, "## Summary")).said).toBe(
      "Filed ISS-1 — J93 judge test: invoice footer typo",
    );
  });

  it("says a refused filing could not be filed, and the refusal's reason in one short line", () => {
    const refused = {
      exitCode: 1,
      stdout: "",
      stderr:
        "Hold — this files an issue the flow cannot carry. Each line below is what was read, what the shape wants and the one command that clears it.\n\n- read: no heading naming what happened, among `Summary`, `Where`\n  wants: a heading saying what happened\n  clear: add `## What happened` and re-send the same command",
    };
    expect(toolWords(cli(["new", "-", "--title", "J93 judge test: invoice footer typo", "--category", "bug"], refused, "## Summary"))).toEqual({
      said: "Couldn't file “J93 judge test: invoice footer typo”",
      refusal: "The What happened section is missing. Ask the assistant to put it right and try again.",
    });
  });

  // ISS-1229 r35, judge-95: the card read the refusal's opening, "Hold — this files an issue the flow
  // cannot carry.", and the reason, four missing headings, was only under Technical details.
  it("says what a held filing lacks and what puts it right, never the refusal's opening", () => {
    const among = ", among `Summary`, `Where`, `Expected behavior`, `Actual behavior`, `Acceptance criteria`";
    const gaps = [
      ["what happened", "What happened"],
      ["why it happens", "Why it happens"],
      ["the outcome", "Outcome"],
      ["the out-of-scope", "Out of scope"],
    ].map(
      ([read, heading]) =>
        `- read: no heading naming ${read}${among}\n  wants: a heading\n  clear: add \`## ${heading}\` and re-send the same command`,
    );
    const refused = {
      exitCode: 1,
      stdout: "",
      stderr: `Hold — this files an issue the flow cannot carry. Each line below is what was read, what the shape wants and the one command that clears it.\n\n${gaps.join("\n")}`,
    };
    const words = toolWords(cli(["new", "-", "--title", "J95 judge test: invoice footer typo", "--category", "bug"], refused));
    expect(words.refusal).toBe(
      "The What happened, Why it happens, Outcome and Out of scope sections are missing. Ask the assistant to put it right and try again.",
    );
    expect(words.refusal).not.toMatch(/Hold|flow cannot carry|among/);
  });

  it("says what puts each gap right where a gap is not a missing section", () => {
    const refused = {
      exitCode: 1,
      stdout: "",
      stderr:
        "Hold — this files an issue the flow cannot carry.\n\n- read: no heading naming what happened, among `Summary`\n  wants: a heading saying what happened, required of a bug\n  clear: add `## What happened` and re-send the same command\n- read: the title `Fix`\n  wants: a sentence saying the behaviour after the change, not one word\n  clear: forge new with a title that says the behaviour",
    };
    expect(toolWords(cli(["new", "-", "--title", "Fix"], refused)).refusal).toBe(
      "The What happened section is missing. Ask the assistant to put it right and try again.",
    );
  });

  it("says why a hold that lists no reads was held, from the paragraph after its instruction", () => {
    const route = {
      exitCode: 1,
      stdout: "",
      stderr:
        "Hold — name one of the routes below, then re-send.\n\nThis body names billing, carries no rule or invariant and no out-of-scope, and reads as a fix: filed as a feature the flow costs a confirmation.\n\n  --with ISS-nn   file it and relate it",
    };
    expect(toolWords(cli(["new", "-", "--title", "Typo"], route)).refusal).toBe(
      "This body names billing, carries no rule or invariant and no out-of-scope, and reads as a fix: filed as a feature the flow costs a confirmation. Ask the assistant to put it right and try again.",
    );
  });

  it("tells a comment written from one only read", () => {
    const ok = { exitCode: 0, stdout: "posted", stderr: "" };
    expect(toolWords(cli(["comment", "ISS-1", "-"], ok, "Also on the PDF export")).said).toBe("Commented on ISS-1");
    expect(toolWords(cli(["comment", "ISS-1"], ok)).said).toBe("Read the comments on ISS-1");
  });

  it("says the knowledge and memory searches, with how many came back", () => {
    const knowledge: ToolCallData = {
      id: "k",
      name: "forge_knowledge",
      input: { topK: 10, query: "invoice footer typo", scope: "knowledge", action: "search", strategy: "hybrid" },
      result: { knowledge: [], memory: [] },
    };
    expect(toolWords(knowledge).said).toBe("Searched project knowledge for “invoice footer typo” — none found");
    const memory: ToolCallData = {
      id: "m",
      name: "forge_memory_search",
      input: { topK: 3, query: "Thursday release", strategy: "keyword" },
      result: { hits: [{ id: "a" }, { id: "b" }], model: "gm/gemini-embedding-001", took_ms: 5 },
    };
    expect(toolWords(memory).said).toBe("Searched project memory for “Thursday release” — 2 found");
  });

  // ISS-1229 r35, judge-95: a search of knowledge and memory found one memory hit and its card read
  // "Searched project knowledge … — 1 found" above a reply saying knowledge held nothing.
  it("says which stores a knowledge search covered, and counts what each one found", () => {
    const search = (scope: string | undefined, result: unknown): ToolCallData => ({
      id: "k",
      name: "forge_knowledge",
      input: { topK: 10, query: "invoices", ...(scope ? { scope } : {}), action: "search", strategy: "hybrid" },
      result,
    });
    const hit = [{ id: "c7ae770e", source: "issue" }];
    expect(toolWords(search("all", { knowledge: [], memory: hit })).said).toBe(
      "Searched project knowledge and memory for “invoices” — none in knowledge, 1 in memory",
    );
    expect(toolWords(search("all", { knowledge: hit, memory: [] })).said).toBe(
      "Searched project knowledge and memory for “invoices” — 1 in knowledge, none in memory",
    );
    expect(toolWords(search("all", { knowledge: [], memory: [] })).said).toBe(
      "Searched project knowledge and memory for “invoices” — none found",
    );
    expect(toolWords(search("memory", { knowledge: [], memory: [...hit, ...hit] })).said).toBe(
      "Searched project memory for “invoices” — 2 found",
    );
    expect(toolWords(search(undefined, { knowledge: hit, memory: hit })).said).toBe(
      "Searched project knowledge for “invoices” — 1 found",
    );
  });

  it("says a call still running in the present, without a result", () => {
    const running: ToolCallData = { id: "r", name: "forge", input: { argv: ["issue", "--search", "csv"] } };
    expect(toolWords(running, true)).toEqual({ said: "Searching issues for “csv”…" });
  });

  it("says Used a tool for a tool the room has no words for, never its stored name", () => {
    const odd: ToolCallData = { id: "o", name: "mcp__acme__frobnicate", input: { level: 3 }, result: { ok: true, n: 1, z: 2 } };
    expect(toolWords(odd)).toEqual({ said: "Used a tool" });
    expect(toolWords({ ...odd, isError: true, result: { message: "Frobnication is off. Ask an admin." } })).toEqual({
      said: "Couldn't use a tool",
      refusal: "Frobnication is off. Ask the assistant to put it right and try again.",
    });
  });

  it("never reads as a result's shape", () => {
    const shapes = [cli(["issue", "--search", "x"], none), cli(["project"], { exitCode: 0, stdout: "{}", stderr: "" })];
    for (const t of shapes) expect(toolWords(t).said).not.toMatch(/Object|fields|forge\b/);
  });
});

describe("a refused card's reason", () => {
  it("names no stored tool, which only the technical details show", () => {
    const closed: ToolCallData = {
      id: "c",
      name: "forge",
      input: { argv: ["deploy"] },
      result: { exitCode: 2, stdout: "", stderr: "`forge deploy` is not open from chat. What is: issue, new." },
      isError: true,
    };
    expect(toolWords(closed).refusal).toBe(`The assistant can't do that from a room. ${DONE_AT_A_TERMINAL}`);
    const stopped = { ...closed, result: { exitCode: 1, stdout: "", stderr: "forge was stopped after 30s with no answer." } };
    expect(toolWords(stopped).refusal).toBe(
      "The tracker did not answer in time. Ask the assistant to check whether it went through before trying again.",
    );
    const other: ToolCallData = { id: "o", name: "forge_guide", input: {}, result: { message: "forge_guide refused: no slug." }, isError: true };
    expect(toolWords(other).refusal).toBe("No slug. Ask the assistant to put it right and try again.");
  });
});

describe("a refusal's reason", () => {
  it("says what was wrong, and the person's way out by the refusal's kind", () => {
    expect(refusalReason({ stderr: `${"a".repeat(200)}.` })).toBe(`A${"a".repeat(199)}. ${PUT_IT_RIGHT}`);
    expect(refusalReason({ exitCode: 1, stdout: "", stderr: "" })).toBe(`It gave no reason. ${PUT_IT_RIGHT}`);
    expect(refusalReason("`forge issue --set` refused.\n`forge issue -h` lists the fields.", "forge")).toBe(
      `Its reason is under Technical details. ${PUT_IT_RIGHT}`,
    );
  });

  // ISS-1229 r38, judge-103: a refused read of a guide that does not exist showed "No guide named
  // issue-claiming." alone, because its suggestion opened on a command no remedy wording matched. The
  // assistant listed the guides next, in the same reply.
  const guide = (argv: string[], out: { exitCode: number; stdout: string; stderr: string }) => cli(argv, out);
  const noGuide = guide(["guide", "issue-claiming"], {
    exitCode: 1,
    stdout: "",
    stderr: "No guide named issue-claiming. `forge guide` lists the guides this plugin stands behind.\n",
  });
  const listedGuides = guide(["guide"], { exitCode: 0, stdout: "contract\n  this plugin's own\n", stderr: "" });
  const readFlow = guide(["guide", "issue-flow"], { exitCode: 0, stdout: "# Skill: issue-flow\n", stderr: "" });

  it("says the assistant tried another way where it did later in the same reply", () => {
    expect(toolWords(noGuide, false, [listedGuides, readFlow])).toEqual({
      said: "Couldn't read the “issue-claiming” guide",
      refusal: `No guide named issue-claiming. ${TOOK_ANOTHER_WAY}`,
    });
  });

  it("asks the person to have the assistant put it right where it did not", () => {
    expect(toolWords(noGuide).refusal).toBe(`No guide named issue-claiming. ${PUT_IT_RIGHT}`);
    const refusedAgain = { ...listedGuides, isError: true, result: { exitCode: 1, stdout: "", stderr: "stopped" } };
    expect(toolWords(noGuide, false, [refusedAgain]).refusal).toBe(`No guide named issue-claiming. ${PUT_IT_RIGHT}`);
    const otherAct = cli(["issue", "ISS-1"], { exitCode: 0, stdout: "{}", stderr: "" });
    expect(toolWords(noGuide, false, [otherAct]).refusal).toBe(`No guide named issue-claiming. ${PUT_IT_RIGHT}`);
    const stillRunning: ToolCallData = { id: "r", name: "forge", input: { argv: ["guide"] } };
    expect(toolWords(noGuide, false, [stillRunning]).refusal).toBe(`No guide named issue-claiming. ${PUT_IT_RIGHT}`);
  });

  // Consult F1 on the round-38 plan: a later success on another target is not the refused work done,
  // unless the refused call named something that does not exist.
  it("counts a later call as putting it right only on the same target, or where the refused one named nothing", () => {
    const tooLarge = guide(["guide", "contract"], { exitCode: 1, stdout: "", stderr: "The guide is too large to print here.\n" });
    const other = guide(["guide", "dispatch"], { exitCode: 0, stdout: "# dispatch\n", stderr: "" });
    const same = guide(["guide", "contract"], { exitCode: 0, stdout: "# contract\n", stderr: "" });
    expect(toolWords(tooLarge, false, [other]).refusal).toBe(`The guide is too large to print here. ${PUT_IT_RIGHT}`);
    expect(toolWords(tooLarge, false, [other, same]).refusal).toBe(`The guide is too large to print here. ${TOOK_ANOTHER_WAY}`);
    expect(toolWords(noGuide, false, [guide(["guide", "issue-flow"], { exitCode: 0, stdout: "# flow\n", stderr: "" })]).refusal).toBe(
      `No guide named issue-claiming. ${TOOK_ANOTHER_WAY}`,
    );
    const knowledge = (argv: string[], exitCode: number, stderr = "") => cli(["knowledge", ...argv], { exitCode, stdout: exitCode ? "" : "{}", stderr });
    const refusedGet = knowledge(["get", "billing"], 1, "The slug is longer than the store keeps.");
    expect(toolWords(refusedGet, false, [knowledge(["search", "billing"], 0)]).refusal).toMatch(/Ask the assistant/);
    expect(toolWords(refusedGet, false, [knowledge(["get", "billing"], 0)]).refusal).toBe(`The slug is longer than the store keeps. ${TOOK_ANOTHER_WAY}`);
  });

  // The whole-set read of round 38 (F1): filings and searches have no positional target, so their title or
  // words are what they acted on; a call naming nothing is never matched by another naming nothing.
  it("tells a filing or search by its title or words, never by its stdin marker", () => {
    const filing = (title: string, exitCode: number) =>
      cli(["new", "-", "--title", title], { exitCode, stdout: exitCode ? "" : '{"issueId":"ISS-2"}', stderr: exitCode ? "The body is empty." : "" });
    expect(toolWords(filing("Footer typo", 1), false, [filing("Header typo", 0)]).refusal).toBe(`The body is empty. ${PUT_IT_RIGHT}`);
    expect(toolWords(filing("Footer typo", 1), false, [filing("Footer typo", 0)]).refusal).toBe(`The body is empty. ${TOOK_ANOTHER_WAY}`);
    const search = (words: string, exitCode: number) =>
      cli(["issue", "--search", words], { exitCode, stdout: exitCode ? "" : "0 issue(s)", stderr: exitCode ? "The search was too short." : "" });
    expect(toolWords(search("ab", 1), false, [search("invoices", 0)]).refusal).toBe(`The search was too short. ${PUT_IT_RIGHT}`);
    expect(toolWords(search("ab", 1), false, [search("ab", 0)]).refusal).toBe(`The search was too short. ${TOOK_ANOTHER_WAY}`);
    const listing = cli(["issue", "--status", "ab"], { exitCode: 0, stdout: "0 issue(s)", stderr: "" });
    expect(toolWords(search("ab", 1), false, [listing]).refusal).toBe(`The search was too short. ${PUT_IT_RIGHT}`);
    const help = guide(["guide", "contract", "--help"], { exitCode: 0, stdout: "Usage: forge guide", stderr: "" });
    const tooLarge = guide(["guide", "contract"], { exitCode: 1, stdout: "", stderr: "The guide is too large to print here.\n" });
    expect(toolWords(tooLarge, false, [help]).refusal).toBe(`The guide is too large to print here. ${PUT_IT_RIGHT}`);
    expect(toolWords(noGuide, false, [help]).refusal).toBe(`No guide named issue-claiming. ${PUT_IT_RIGHT}`);
    const comment = (argv: string[], exitCode: number) =>
      cli(["comment", "ISS-1", ...argv], { exitCode, stdout: exitCode ? "" : "posted", stderr: exitCode ? "The comment is empty." : "" });
    expect(toolWords(comment(["-"], 1), false, [comment([], 0)]).refusal).toBe(`The comment is empty. ${PUT_IT_RIGHT}`);
    expect(toolWords(comment(["-"], 1), false, [comment(["-"], 0)]).refusal).toBe(`The comment is empty. ${TOOK_ANOTHER_WAY}`);
    const bare = cli(["next"], { exitCode: 1, stdout: "", stderr: "The queue could not be read." });
    expect(toolWords(bare, false, [cli(["next"], { exitCode: 0, stdout: "ISS-1", stderr: "" })]).refusal).toBe(
      `The queue could not be read. ${PUT_IT_RIGHT}`,
    );
  });

  it("chooses the way out by kind, never by how the suggestion is worded", () => {
    for (const suggestion of ["Run `forge guide` to list them.", "`forge guide` lists them.", "The list is on `forge guide`."]) {
      expect(refusalReason(`No guide named x. ${suggestion}`, "forge")).toBe(`No guide named x. ${PUT_IT_RIGHT}`);
      expect(refusalReason(`No guide named x. ${suggestion}`, "forge", true)).toBe(`No guide named x. ${TOOK_ANOTHER_WAY}`);
    }
  });

  it("keeps the person's own way out for a key they named, whatever came later", () => {
    const missing = cli(["issue", "ISS-999"], {
      exitCode: 1,
      stdout: "",
      stderr: "ISS-999 is not on this project's tracker; 1 issue(s) were counted, which is the whole backlog.\nThe keys it does hold are on `forge issue`, one per line.\n",
    });
    const listed = cli(["issue"], { exitCode: 0, stdout: "ISS-1 low draft Footer\n\n1 issue(s) over 1 page(s)\n", stderr: "" });
    expect(toolWords(missing, false, [listed]).refusal).toBe(
      "ISS-999 is not on this project's tracker. Check the key, or ask the assistant to list this project's issues.",
    );
  });

  // ISS-1229 r37, judge-100: the refused comment's card read "ISS-999 is not on this project's tracker. The
  // keys it does hold are on the tracker's `issue` command, one per line." — the agent's command-line
  // remedy, with literal backticks, and nothing the person reading the room could do.
  it("gives the person reading the room what they can do, never the agent's command", () => {
    const stored = {
      exitCode: 1,
      stdout: "",
      stderr:
        "ISS-999 is not on this project's tracker; 1 issue(s) were counted, which is the whole backlog.\nThe keys it does hold are on `forge issue`, one per line.\n",
    };
    const words = toolWords(cli(["comment", "ISS-999", "-"], stored));
    expect(words.said).toBe("Couldn't comment on ISS-999");
    expect(words.refusal).toBe(
      "ISS-999 is not on this project's tracker. Check the key, or ask the assistant to list this project's issues.",
    );
    expect(words.refusal).not.toMatch(/`|command|one per line|were counted|backlog/);
    expect((words.refusal as string).length).toBeLessThanOrEqual(120);
  });

  it("puts no literal backtick on the card, whatever the refusal quotes", () => {
    const quoted = "The body has no `## Outcome` heading. Add the `## Outcome` section and send it again.";
    expect(refusalReason(quoted, "forge")).toBe(`The body has no ## Outcome heading. ${PUT_IT_RIGHT}`);
    const mcp = "NOT_FOUND: id `ISS-9` is a display key, and this project holds no issue at that number. Nothing was read or written. `forge_issues action=list` prints the keys it does hold under issueId.";
    const line = refusalReason(mcp, "forge_issues");
    expect(line).not.toMatch(/`|action=|issueId|NOT_FOUND/);
    expect(line).toBe(
      "Id ISS-9 is a display key, and this project holds no issue at that number. Check the key, or ask the assistant to list this project's issues.",
    );
  });

  // The whole-set read of round 37 (F2): a remedy longer than the line pushed the line past its limit.
  it("keeps the line to its limit and its reason first where the remedy alone would fill it", () => {
    const line = refusalReason(`The request was refused. Add ${"a".repeat(140)}.`, "forge");
    expect(line.length).toBeLessThanOrEqual(121);
    expect(line.startsWith("The request was refused.")).toBe(true);
  });

  it("says the wrong before the remedy, and the agent's remedy as one the person can ask for", () => {
    expect(refusalReason("Run `forge comment ISS-1 -` first. The issue is leased by another run.", "forge")).toBe(
      "The issue is leased by another run. Ask the assistant to put it right and try again.",
    );
    // r40: `forge claim` is no act a room opens, so asking the assistant again could not work (judge-111).
    expect(refusalReason("Run `forge claim` first. The issue is leased by another run.", "forge")).toBe(
      "The issue is leased by another run. That is done at a terminal.",
    );
  });

  it("says a refusal about what the assistant may do from a room in the person's words", () => {
    expect(refusalReason("`forge knowledge write` is not open from chat; list/get/search are.", "forge")).toBe(
      `The assistant can't do that from a room. ${DONE_AT_A_TERMINAL}`,
    );
  });
});

// ISS-1229 r39, judge-107 at 7d4a69d: a claim refused as a status change read "Couldn't read ISS-1" over
// "The tracker issue failed: status is not a field an update writes: the…", and a filing missing four
// sections read "No What happened, Why it happens, Outcome or Ou…". Both are the stored refusals.
describe("a refused card in whole sentences", () => {
  const statusRefusal =
    "forge issue failed: status is not a field an update writes: the tracker moves it on a route of its own and refuses it here, and the fields of one call go up together, so nothing of this one was sent. Move it with:\n  forge advance ISS-1 --set in_progress --why <w>\n";
  const claim = cli(["issue", "ISS-1", "--set", "status=in_progress"], { exitCode: 1, stdout: "", stderr: statusRefusal });

  it("titles a refused status change for the move it tried", () => {
    expect(toolWords(claim).said).toBe("Couldn't move ISS-1 to In progress");
    const done = cli(["issue", "ISS-1", "--set", "status=closed"], { exitCode: 0, stdout: "{}", stderr: "" });
    expect(toolWords(done).said).toBe("Moved ISS-1 to Closed");
    const advance = cli(["advance", "ISS-1", "--set", "in_progress", "--why", "x"], { exitCode: 2, stdout: "", stderr: "`forge advance` is not open from chat. What is: issue, new." });
    expect(toolWords(advance).said).toBe("Couldn't move ISS-1 to In progress");
    expect(toolWords(cli(["advance", "ISS-1"], { exitCode: 0, stdout: "", stderr: "" })).said).toBe("Moved ISS-1 to its next status");
    const priority = cli(["issue", "ISS-1", "--set", "priority=high", "--why", "x"], { exitCode: 0, stdout: "{}", stderr: "" });
    expect(toolWords(priority).said).toBe("Updated ISS-1");
    expect(toolWords(cli(["issue", "ISS-1", "--blocks", "ISS-2"], { exitCode: 0, stdout: "{}", stderr: "" })).said).toBe("Updated ISS-1");
    expect(toolWords(cli(["issue", "ISS-1"], { exitCode: 0, stdout: "{}", stderr: "" })).said).toBe("Read ISS-1");
  });

  it("says what was wrong as a whole clause, without the command's own prefix", () => {
    const line = toolWords(claim).refusal as string;
    expect(line).toBe("Status is not a field an update writes. A status is moved on the issue's page.");
    expect(line).not.toMatch(/…|failed:|tracker issue|forge/);
  });

  it("names a filing's missing sections in one whole sentence", () => {
    const gaps = ["What happened", "Why it happens", "Outcome", "Out of scope"].map(
      (h) => `- read: no heading naming ${h.toLowerCase()}, among \`Summary\`, \`Where\`\n  wants: a heading\n  clear: add \`## ${h}\` and re-send the same command`,
    );
    const filing = cli(["new", "-", "--title", "[Bug] PDF export footer shows last year"], {
      exitCode: 1,
      stdout: "",
      stderr: `Hold — this files an issue the flow cannot carry. Each line below is what was read, what the shape wants and the one command that clears it.\n\n${gaps.join("\n")}`,
    });
    const line = toolWords(filing).refusal as string;
    expect(line.startsWith("The What happened, Why it happens, Outcome and Out of scope sections are missing.")).toBe(true);
    expect(line).not.toMatch(/…|\bNo What\b/);
  });

  it("never cuts a sentence or a word at a character count, however long the reason", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
    for (const reason of [`${words(40)}.`, `${words(10)}; ${words(30)}.`, `${words(10)}. ${words(30)}.`, "a".repeat(300)]) {
      const line = refusalReason(reason, "forge");
      expect(line).not.toContain("…");
      const shown = line.slice(0, -PUT_IT_RIGHT.length - 1);
      expect(reason.toLowerCase().startsWith(shown.replace(/\.$/, "").toLowerCase())).toBe(true);
      expect(/[.!?]$/.test(shown) || shown.toLowerCase() === reason).toBe(true);
    }
  });

  it("drops a tool's failure prefix wherever it leads, never rewording it", () => {
    for (const prefix of ["forge issue failed: ", "forge failed: ", "forge_issues refused: ", "forge comment refused: "]) {
      expect(refusalReason(`${prefix}the comment is empty.`, prefix.startsWith("forge_") ? "forge_issues" : "forge")).toBe(
        `The comment is empty. ${PUT_IT_RIGHT}`,
      );
    }
  });
});

// ISS-1229 r39, judge-107: the assistant read a guide through the CLI, was refused twice, then read it
// through the forge_guide tool; both refused cards still asked the person to have it put right.
describe("one act, one identity across its doors", () => {
  const cliGuide = (slug: string, exitCode: number) =>
    cli(["guide", slug], { exitCode, stdout: exitCode ? "" : "# guide", stderr: exitCode ? `No guide named ${slug}. \`forge guide\` lists the guides this plugin stands behind.\n` : "" });
  const mcpGuide = (slug: string): ToolCallData => ({ id: "g", name: "forge_guide", input: { action: "get", slug }, result: { slug, body: "# guide" } });

  it("counts a guide read through the tool as the same act the CLI was refused", () => {
    const later = [cliGuide("pipeline-and-issue-lifecycle", 1), mcpGuide("pipeline-and-issue-lifecycle")];
    expect(toolWords(cliGuide("issue-claiming", 1), false, later).refusal).toBe(`No guide named issue-claiming. ${TOOK_ANOTHER_WAY}`);
    expect(toolWords(later[0] as ToolCallData, false, later.slice(1)).refusal).toBe(
      `No guide named pipeline-and-issue-lifecycle. ${TOOK_ANOTHER_WAY}`,
    );
  });

  it("matches every door the table names to its CLI verb, and no other door", () => {
    const gone = (what: string) => ({ exitCode: 1, stdout: "", stderr: `${what} not found.` });
    const pairs: Record<string, [ToolCallData, ToolCallData]> = {
      forge_guide: [cliGuide("contract", 1), mcpGuide("contract")],
      forge_knowledge: [
        cli(["knowledge", "get", "billing"], gone("The entry was")),
        { id: "k", name: "forge_knowledge", input: { action: "get", slug: "billing" }, result: {} },
      ],
      forge_memory_search: [
        cli(["knowledge", "search", "billing", "--scope", "memory"], gone("The store was")),
        { id: "m", name: "forge_memory_search", input: { query: "billing" }, result: { hits: [] } },
      ],
      forge_projects_get: [cli(["project"], gone("The project was")), { id: "p", name: "forge_projects_get", input: {}, result: {} }],
    };
    expect(Object.keys(pairs).sort()).toEqual(Object.keys(DOOR_OF_TOOL).sort());
    for (const [tool, [refused, through]] of Object.entries(pairs)) {
      expect(toolWords(refused, false, [through]).refusal, tool).toMatch(/The assistant tried another way below/);
      const elsewhere = { ...through, name: "forge_memory_note" };
      expect(toolWords(refused, false, [elsewhere]).refusal, tool).toMatch(/Ask the assistant to put it right/);
    }
  });
});

// ISS-1229 r40, judge-111 at abdd0d7: a status change tried the wrong way read "Status is not a field an
// update writes. Ask the assistant to put it right and try again." The person asked; the assistant's
// retry through `forge advance` was refused as not open from a room, which no room ever opens. A card's
// way out comes from the table the room's door refuses by, so it is one that works where it is shown.
describe("a refused card's way out works where the card is shown", () => {
  const statusRefusal =
    "forge issue failed: status is not a field an update writes: the tracker moves it on a route of its own and refuses it here, and the fields of one call go up together, so nothing of this one was sent. Move it with:\n  forge advance ISS-1 --set in_progress --why <w>\n";
  const MOVED_ON_THE_PAGE = "A status is moved on the issue's page.";

  it("says where a status is moved, never to ask the assistant again, for judge-111's two cards", () => {
    const claim = cli(["issue", "ISS-1", "--set", "status=in_progress"], { exitCode: 1, stdout: "", stderr: statusRefusal });
    expect(toolWords(claim).refusal).toBe(`Status is not a field an update writes. ${MOVED_ON_THE_PAGE}`);
    const retry = cli(["advance", "ISS-1", "--set", "in_progress", "--why", "x"], {
      exitCode: 2,
      stdout: "",
      stderr: "`forge advance` is not open from chat. What is: issue, new, comment. A status is moved on the issue's page.",
    });
    expect(toolWords(retry).refusal).toBe(`The assistant can't do that from a room. ${MOVED_ON_THE_PAGE}`);
    for (const card of [claim, retry]) expect(toolWords(card).refusal).not.toMatch(/put it right|tried another way/);
  });

  it("names where it is done even where a later call of the same act went through", () => {
    const claim = cli(["issue", "ISS-1", "--set", "status=in_progress"], { exitCode: 1, stdout: "", stderr: statusRefusal });
    const later = cli(["issue", "ISS-1", "--set", "priority=high"], { exitCode: 0, stdout: "{}", stderr: "" });
    expect(toolWords(claim, false, [later]).refusal).toBe(`Status is not a field an update writes. ${MOVED_ON_THE_PAGE}`);
  });

  it("walks the table: a command a room does not open is never offered back to the assistant", () => {
    for (const verb of ["advance", "claim", "record", "deploy", "coolify", "doctor"]) {
      expect(ROOM_VERBS).not.toContain(verb);
      const line = refusalReason(`The move was refused. Do it with:\n  forge ${verb} ISS-1\n`, "forge");
      expect(line, verb).toBe(`The move was refused. ${whereItIsDone(verb)}`);
    }
    expect(refusalReason("The entry was not written. Write it with `forge knowledge write billing -`.", "forge")).toBe(
      `The entry was not written. ${DONE_AT_A_TERMINAL}`,
    );
  });

  it("keeps the assistant's way out where every command the refusal names is one a room opens", () => {
    for (const verb of ROOM_VERBS) {
      const sub = verb === "knowledge" ? ` ${ROOM_KNOWLEDGE_READS[0]}` : "";
      expect(refusalReason(`The call was refused. Try:\n  forge ${verb}${sub} ISS-1\n`, "forge"), verb).toBe(
        `The call was refused. ${PUT_IT_RIGHT}`,
      );
    }
  });

  it("reads a tool's own failure prefix, and a sentence opening on the tool's name, as no command", () => {
    expect(refusalReason("forge knowledge failed: the store did not answer.", "forge")).toBe(
      `The store did not answer. ${PUT_IT_RIGHT}`,
    );
    expect(refusalReason("forge was stopped before the store answered.", "forge")).toBe(
      `The tracker was stopped before the store answered. ${PUT_IT_RIGHT}`,
    );
  });
});
