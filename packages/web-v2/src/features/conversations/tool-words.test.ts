// ISS-1229 r34, judge-93: a room's tool cards read "Object · 3 fields", and a filing the tracker refused
// once then accepted left a bare "forge — Failed". The shapes below are the ones judge-93 read back off
// a room on beta 61b8876, and judge-95's off beta 2b0f8aa (r35).

import { describe, expect, it } from "vitest";
import { decodeToolOutput } from "@/features/session/result-summary";
import type { ToolCallData } from "@/features/session/types";
import { PUT_IT_RIGHT, refusalReason, TOOK_ANOTHER_WAY, toolWords } from "./tool-words";

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
      refusal: "No What happened section. Ask the assistant to put it right and try again.",
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
      "No What happened, Why it happens, Outcome or Out of scope section. Ask the assistant to put it right and try again.",
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
      "No What happened section. Ask the assistant to put it right and try again.",
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
      "This body names billing, carries no rule or invariant and no out-of-sc… Ask the assistant to put it right and try again.",
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
    expect(toolWords(closed).refusal).toBe(
      "The assistant can't do that from a room. Here it can read, file and comment on issues.",
    );
    const stopped = { ...closed, result: { exitCode: 1, stdout: "", stderr: "forge was stopped after 30s with no answer." } };
    expect(toolWords(stopped).refusal).toBe(
      "The tracker did not answer in time. Ask the assistant to check whether it went through before trying again.",
    );
    const other: ToolCallData = { id: "o", name: "forge_guide", input: {}, result: { message: "forge_guide refused: no slug." }, isError: true };
    expect(toolWords(other).refusal).toBe("The tool refused: no slug. Ask the assistant to put it right and try again.");
  });
});

describe("a refusal's reason", () => {
  it("says what was wrong, and the person's way out by the refusal's kind", () => {
    expect(refusalReason({ stderr: `${"a".repeat(200)}.` })).toBe(`${"a".repeat(70)}… ${PUT_IT_RIGHT}`);
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

  it("says the assistant tried another way where it did later in the same reply", () => {
    expect(toolWords(noGuide, false, [listedGuides])).toEqual({
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
    expect(line.endsWith("Check the key, or ask the assistant to list this project's issues.")).toBe(true);
    expect(line.length).toBeLessThanOrEqual(120);
  });

  // The whole-set read of round 37 (F2): a remedy longer than the line pushed the line past its limit.
  it("keeps the line to its limit and its reason first where the remedy alone would fill it", () => {
    const line = refusalReason(`The request was refused. Add ${"a".repeat(140)}.`, "forge");
    expect(line.length).toBeLessThanOrEqual(121);
    expect(line.startsWith("The request was refused.")).toBe(true);
  });

  it("says the wrong before the remedy, and the agent's remedy as one the person can ask for", () => {
    expect(refusalReason("Run `forge claim` first. The issue is leased by another run.", "forge")).toBe(
      "The issue is leased by another run. Ask the assistant to put it right and try again.",
    );
  });

  it("says a refusal about what the assistant may do from a room in the person's words", () => {
    expect(refusalReason("`forge knowledge write` is not open from chat; list/get/search are.", "forge")).toBe(
      "The assistant can't do that from a room. Here it can read, file and comment on issues.",
    );
  });
});
