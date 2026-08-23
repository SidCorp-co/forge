import { describe, expect, it } from "vitest";
import type { SessionRow } from "@/features/sessions/types";
import {
  deriveActivityGroups,
  deriveBlocker,
  deriveNarration,
  deriveTape,
  deriveTimeSpend,
  deriveTranscriptRows,
  mcpServer,
  readTranscriptMeta,
  shortenPath,
  toolOutcome,
} from "./run-report";
import type { ConversationItem, ToolCallData } from "./types";

function tool(over: Partial<ToolCallData> & { name: string }): ToolCallData {
  return {
    id: over.id ?? `t-${over.name}`,
    name: over.name,
    input: over.input,
    result: over.result,
    isError: over.isError,
  };
}

function agentItem(
  blocks: ConversationItem["blocks"],
  over: Partial<ConversationItem> = {},
): ConversationItem {
  return {
    id: over.id ?? "i1",
    turnId: "",
    turnIndex: over.turnIndex ?? 0,
    role: "assistant",
    kind: "agent",
    text: "",
    blocks,
    attachments: [],
    editedAt: null,
    thinkingCount: over.thinkingCount ?? 0,
    ...(over.timestamp !== undefined ? { timestamp: over.timestamp } : {}),
  };
}

const toolBlock = (tc: ToolCallData) => ({ type: "tool" as const, tool: tc });

describe("toolOutcome", () => {
  it("reads pass/fail counts out of a test run rather than echoing its first line", () => {
    const out = toolOutcome(
      tool({
        name: "Bash",
        input: { command: "pnpm test" },
        result: "RUN v3\n\n Test Files  1 failed | 212 passed\n      Tests  428 passed | 1 failed",
      }),
    );
    expect(out).toEqual({ text: "428 passed, 1 failed", tone: "bad" });
  });

  it("calls an all-green run ok", () => {
    expect(toolOutcome(tool({ name: "Bash", result: "Tests  428 passed" }))).toEqual({
      text: "428 passed",
      tone: "ok",
    });
  });

  it("counts lines for a Read instead of dumping the file", () => {
    expect(toolOutcome(tool({ name: "Read", result: "a\nb\nc" }))).toEqual({
      text: "3 lines",
      tone: "muted",
    });
  });

  it("reports an edit as its line delta", () => {
    const out = toolOutcome(
      tool({ name: "Edit", input: { file_path: "a.ts", old_string: "x\ny", new_string: "x\ny\nz" } }),
    );
    expect(out).toEqual({ text: "+3 −2", tone: "ok" });
  });

  it("an errored call reports its error, whatever its kind would have said", () => {
    const out = toolOutcome(
      tool({ name: "Read", isError: true, result: "ENOENT: no such file or directory" }),
    );
    expect(out).toEqual({ text: "ENOENT: no such file or directory", tone: "bad" });
  });
});

describe("mcpServer", () => {
  it("names the server behind an MCP tool and stays empty for a native one", () => {
    expect(mcpServer("mcp__forge__forge_issues")).toBe("forge");
    expect(mcpServer("Bash")).toBe("");
  });
});

describe("shortenPath", () => {
  it("drops everything up to and including the worktree segment", () => {
    expect(
      shortenPath(
        "/home/forge/projects/getcontent/.claude/worktrees/iss-455/packages/core/src/x.ts",
        "/home/kieutrung/tools/getcontent",
      ),
    ).toBe("packages/core/src/x.ts");
  });

  it("falls back to stripping the checkout prefix when there is no worktree", () => {
    expect(shortenPath("/srv/repo/apps/api/src/routes.ts", "/srv/repo")).toBe(
      "apps/api/src/routes.ts",
    );
  });

  it("returns the path unchanged when neither applies, rather than an empty string", () => {
    expect(shortenPath("src/a.ts", "/srv/repo")).toBe("src/a.ts");
    expect(shortenPath("/srv/repo", "/srv/repo")).toBe("/srv/repo");
  });
});

describe("deriveActivityGroups", () => {
  const items = [
    agentItem([
      toolBlock(tool({ id: "a", name: "Read", input: { file_path: "a.ts" }, result: "one\ntwo" })),
      toolBlock(tool({ id: "b", name: "Grep", input: { pattern: "held" }, result: "hit" })),
      toolBlock(tool({ id: "c", name: "Bash", input: { command: "pnpm build" }, result: "ok" })),
      toolBlock(
        tool({ id: "d", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y\nz" } }),
      ),
      toolBlock(tool({ id: "e", name: "mcp__forge__forge_issues", input: { action: "update" }, result: "{}" })),
      toolBlock(tool({ id: "f", name: "Bash", input: { command: "pnpm test" }, isError: true, result: "exit 1" })),
    ]),
  ];

  it("folds every call into the five rows, errors first", () => {
    expect(deriveActivityGroups(items).map((g) => g.kind)).toEqual([
      "errors",
      "ran",
      "edited",
      "forge",
      "explored",
    ]);
  });

  it("an errored call is counted as an error and not also as the command it ran", () => {
    const groups = deriveActivityGroups(items);
    expect(groups.find((g) => g.kind === "errors")?.total).toBe(1);
    expect(groups.find((g) => g.kind === "ran")?.total).toBe(1);
  });

  it("counts DISTINCT files edited, not edit calls", () => {
    const repeated = deriveActivityGroups([
      agentItem([
        toolBlock(tool({ id: "1", name: "Edit", input: { file_path: "a.ts", new_string: "x" } })),
        toolBlock(tool({ id: "2", name: "Edit", input: { file_path: "a.ts", new_string: "y" } })),
        toolBlock(tool({ id: "3", name: "Edit", input: { file_path: "b.ts", new_string: "z" } })),
      ]),
    ]);
    const edited = repeated.find((g) => g.kind === "edited");
    expect(edited?.headline).toBe("Edited 2 files");
    expect(edited?.total).toBe(3);
  });

  it("sums the edit delta across the group", () => {
    expect(deriveActivityGroups(items).find((g) => g.kind === "edited")?.meta).toBe("+2 −1");
  });

  it("splits explored into reads and searches", () => {
    expect(deriveActivityGroups(items).find((g) => g.kind === "explored")?.meta).toBe(
      "1 read · 1 searched",
    );
  });

  it("drops a group nothing landed in", () => {
    const only = deriveActivityGroups([agentItem([toolBlock(tool({ name: "Read", result: "x" }))])]);
    expect(only.map((g) => g.kind)).toEqual(["explored"]);
  });
});

describe("deriveTranscriptRows", () => {
  it("labels an MCP call by its server and keeps the identifying argument", () => {
    const rows = deriveTranscriptRows([
      agentItem([
        toolBlock(
          tool({ id: "m", name: "mcp__forge__forge_memory", input: { action: "search" }, result: "3 hits" }),
        ),
      ]),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: "MCP forge", isMcp: true, arg: "search" });
  });

  it("carries the full output as the expandable body", () => {
    const rows = deriveTranscriptRows([
      agentItem([toolBlock(tool({ name: "Read", input: { file_path: "a.ts" }, result: "l1\nl2\nl3" }))]),
    ]);
    expect(rows[0].body).toBe("l1\nl2\nl3");
    expect(rows[0].outcome.text).toBe("3 lines");
  });
});

describe("deriveTape", () => {
  it("emits one tick per event, typed, in order", () => {
    const ticks = deriveTape([
      agentItem(
        [
          { type: "text", text: "planning" },
          toolBlock(tool({ name: "Read" })),
          toolBlock(tool({ name: "Edit", input: { file_path: "a.ts" } })),
          toolBlock(tool({ name: "Bash", isError: true })),
        ],
        { thinkingCount: 2 },
      ),
    ]);
    expect(ticks).toEqual(["think", "think", "prose", "tool", "edit", "err"]);
  });
});

describe("deriveBlocker", () => {
  it("names the LAST failure, because an agent that recovered from the first was not blocked by it", () => {
    const blocker = deriveBlocker([
      agentItem([
        toolBlock(
          tool({ id: "x", name: "Read", input: { file_path: "gone.ts" }, isError: true, result: "ENOENT" }),
        ),
        toolBlock(
          tool({ id: "y", name: "Bash", input: { command: "pnpm test" }, isError: true, result: "exit 1" }),
        ),
      ]),
    ]);
    expect(blocker).toMatchObject({ label: "Ran pnpm test", output: "exit 1", errorCount: 2 });
  });

  it("is null when nothing failed", () => {
    expect(deriveBlocker([agentItem([toolBlock(tool({ name: "Read" }))])])).toBeNull();
  });
});

describe("readTranscriptMeta", () => {
  it("finds the run totals on the result entry the flattened items drop", () => {
    const meta = readTranscriptMeta(
      [
        { type: "assistant", thinkingCount: 3, blocks: [] },
        { type: "system", subtype: "result", totals: { totalCostUsd: 2.41, numTurns: 41 } },
      ],
      [],
    );
    expect(meta.totals).toEqual({ totalCostUsd: 2.41, numTurns: 41 });
    expect(meta.thinkingPauses).toBe(3);
  });

  it("falls back to the items when the session has no raw transcript (turns path)", () => {
    const meta = readTranscriptMeta(null, [agentItem([], { thinkingCount: 5 })]);
    expect(meta.totals).toBeNull();
    expect(meta.thinkingPauses).toBe(5);
  });
});

describe("deriveTimeSpend", () => {
  const session = {
    createdAt: "2026-08-23T00:58:06.000Z",
    dispatchedAt: "2026-08-23T00:58:13.000Z",
    startedAt: "2026-08-23T00:58:28.000Z",
    updatedAt: "2026-08-23T01:01:18.000Z",
  } as SessionRow;

  it("splits the wall clock into queued, startup and agent", () => {
    const spend = deriveTimeSpend(session);
    expect(spend?.totalMs).toBe(192_000);
    expect(spend?.spans.map((s) => [s.key, s.ms])).toEqual([
      ["queued", 7_000],
      ["startup", 15_000],
      ["agent", 170_000],
    ]);
  });

  it("drops a span whose stamps are missing rather than folding it into its neighbour", () => {
    const spend = deriveTimeSpend({ ...session, dispatchedAt: null } as SessionRow);
    expect(spend?.spans.map((s) => s.key)).toEqual(["agent"]);
    expect(spend?.totalMs).toBe(192_000);
  });
});

const said = (text: string) => ({ type: "text" as const, text });

describe("the agent's own prose", () => {
  it("interleaves what the agent said with what it ran, in order", () => {
    const rows = deriveTranscriptRows([
      agentItem([
        said("Now the route itself."),
        toolBlock(tool({ name: "Read", input: { file_path: "/repo/a.ts" } })),
        said("Green."),
      ]),
    ]);

    expect(rows.map((r) => r.kind)).toEqual(["said", "tool", "said"]);
    expect(rows[0].arg).toBe("Now the route itself.");
    expect(rows[0].outcome.text).toBe("");
  });

  it("skips blocks that are only whitespace, which every turn ends with", () => {
    const rows = deriveTranscriptRows([agentItem([said("   \n  "), said("real")])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].arg).toBe("real");
  });

  it("closes on the last substantive verdict, not the last step marker", () => {
    const verdict = `Both actions are done. ${"x".repeat(150)}`;
    const n = deriveNarration([
      agentItem([said("First, the schema."), said(verdict), said("Now the close comment.")]),
    ]);

    expect(n.closing).toBe(verdict);
    expect(n.count).toBe(3);
  });

  it("falls back to the last note when the agent never wrote a long one", () => {
    const n = deriveNarration([agentItem([said("one"), said("two")])]);
    expect(n.closing).toBe("two");
  });

  it("does not put the runner's own status lines in the agent's voice", () => {
    const system = agentItem([said("Session started")], { id: "sys" });
    system.role = "tool";
    const items = [system, agentItem([said("I'll start by reading the issue.")], { id: "a1" })];

    expect(deriveTranscriptRows(items).map((r) => r.arg)).toEqual([
      "I'll start by reading the issue.",
    ]);
    expect(deriveNarration(items).count).toBe(1);
  });

  it("reports nothing to show for a run that only made tool calls", () => {
    const n = deriveNarration([agentItem([toolBlock(tool({ name: "Read" }))])]);
    expect(n).toEqual({ closing: null, count: 0 });
  });
});
