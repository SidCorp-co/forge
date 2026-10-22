// ISS-1229 r34, judge-93: a room's tool cards read "Object · 3 fields", and a filing the tracker refused
// once then accepted left a bare "forge — Failed". The shapes below are the ones judge-93 read back off
// a room on beta 61b8876, and judge-95's off beta 2b0f8aa (r35).

import { describe, expect, it } from "vitest";
import { decodeToolOutput } from "@/features/session/result-summary";
import type { ToolCallData } from "@/features/session/types";
import { refusalReason, toolWords } from "./tool-words";

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
      refusal: "No heading naming what happened.",
    });
  });

  // ISS-1229 r35, judge-95: the card read the refusal's opening, "Hold — this files an issue the flow
  // cannot carry.", and the reason, four missing headings, was only under Technical details.
  it("says why a filing was held, from what the refusal read, never its opening", () => {
    const among = ", among `Summary`, `Where`, `Expected behavior`, `Actual behavior`, `Acceptance criteria`";
    const reads = ["what happened", "why it happens", "the outcome", "the out-of-scope"].map(
      (r) => `- read: no heading naming ${r}${among}\n  wants: a heading\n  clear: add it and re-send the same command`,
    );
    const refused = {
      exitCode: 1,
      stdout: "",
      stderr: `Hold — this files an issue the flow cannot carry. Each line below is what was read, what the shape wants and the one command that clears it.\n\n${reads.join("\n")}`,
    };
    const words = toolWords(cli(["new", "-", "--title", "J95 judge test: invoice footer typo", "--category", "bug"], refused));
    expect(words.refusal).toBe("No heading naming what happened, why it happens, the outcome or the out-of-scope.");
    expect(words.refusal).not.toMatch(/Hold|flow cannot carry|among/);
  });

  it("says why a hold that lists no reads was held, from the paragraph after its instruction", () => {
    const route = {
      exitCode: 1,
      stdout: "",
      stderr:
        "Hold — name one of the routes below, then re-send.\n\nThis body names billing, carries no rule or invariant and no out-of-scope, and reads as a fix: filed as a feature the flow costs a confirmation.\n\n  --with ISS-nn   file it and relate it",
    };
    expect(toolWords(cli(["new", "-", "--title", "Typo"], route)).refusal).toBe(
      "This body names billing, carries no rule or invariant and no out-of-scope, and reads as a fix: filed as a feature the fl…",
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
      refusal: "Frobnication is off.",
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
    expect(toolWords(closed).refusal).toBe("`deploy` is not open from chat.");
    const stopped = { ...closed, result: { exitCode: 1, stdout: "", stderr: "forge was stopped after 30s with no answer." } };
    expect(toolWords(stopped).refusal).toBe("The tracker was stopped after 30s with no answer.");
    const other: ToolCallData = { id: "o", name: "forge_guide", input: {}, result: { message: "forge_guide refused: no slug." }, isError: true };
    expect(toolWords(other).refusal).toBe("The tool refused: no slug.");
  });
});

describe("a refusal's reason", () => {
  it("is its first sentence, shortened past 120 characters, or says there was none", () => {
    expect(refusalReason("`forge deploy` is not open from chat. What is: issue, new.")).toBe("`forge deploy` is not open from chat.");
    expect(refusalReason({ stderr: `${"a".repeat(200)}.` })).toBe(`${"a".repeat(120)}…`);
    expect(refusalReason({ exitCode: 1, stdout: "", stderr: "" })).toBe("It gave no reason.");
  });
});
