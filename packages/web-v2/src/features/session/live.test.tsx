// ISS-1268: what a running turn produces reaches the session screen live and unstored. The frames
// carry the items `runner-agent/src/chat_live.rs` reads off Claude Code 2.1.322 (its
// `fixtures/stream-json`): deltas stream into the thread, a planted retry and compaction and a rate
// limit say themselves on the status line, the context meter moves, and the suggestion the turn
// ends with is a chip that fills the composer.

import type { AgentSessionLiveItem } from "@forge/contracts/agent-session-live";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatComposer } from "@/features/chat";
import { productCopy } from "@/lib/i18n/product-copy";
import { routeEvent } from "@/lib/ws/event-router";
import { type LiveTurn, liveTurnKey } from "@/lib/ws/live-turn";
import { ToolCall } from "./components/tool-call";
import { TurnStage } from "./components/turn-stage";
import { contextShare, liveItem, liveStatus } from "./live";

afterEach(cleanup);

const SESSION = "22222222-2222-4222-8222-222222222222";
const t = productCopy();
const clock = (s: number) => new Date(s * 1000).toISOString().slice(11, 16);

/** Route one `agent-session.live` frame and answer the session's live turn after it. */
function frame(qc: QueryClient, items: AgentSessionLiveItem[]): LiveTurn | undefined {
  routeEvent({ event: "agent-session.live", data: { sessionId: SESSION, projectId: "p", conversationId: null, items }, timestamp: "" } as never, qc);
  return qc.getQueryData<LiveTurn>(liveTurnKey(SESSION));
}

describe("a reply streams into the thread as it is generated", () => {
  it("joins the deltas into the streaming tail and keeps it only until the transcript holds it", () => {
    const qc = new QueryClient();
    frame(qc, [{ kind: "message", id: "msg_1", parent: null }, { kind: "text", text: "Hello there", parent: null }]);
    let live = frame(qc, [{ kind: "text", text: ", friendly neighbour!", parent: null }]);
    expect(liveItem(live, 0)?.blocks).toEqual([{ type: "text", text: "Hello there, friendly neighbour!" }]);
    live = frame(qc, [{ kind: "messageEnd", id: "msg_1", parent: null }]);
    const stopped = live?.stoppedAt ?? 0;
    expect(liveItem(live, stopped - 1)).not.toBeNull();
    expect(liveItem(live, stopped)).toBeNull();
    // the frame wrote the live turn and invalidated nothing a fetch would answer
    expect(qc.getQueryState(["agent-session", SESSION, "turns"])).toBeUndefined();
  });

  it("leaves a subagent's text to the call that spawned it", () => {
    const qc = new QueryClient();
    const live = frame(qc, [{ kind: "message", id: "m", parent: null }, { kind: "text", text: "sub", parent: "toolu_1" }]);
    expect(live?.text).toBe("");
  });
});

describe("the status line says what holds the turn up", () => {
  const stage = (status: string | null, context: number | null) =>
    render(<TurnStage stage="working" status={status} context={context} />);

  it("shows a planted retry with its attempt, then a compaction", () => {
    const qc = new QueryClient();
    let live = frame(qc, [{ kind: "status", status: "requesting" }, { kind: "retry", attempt: 2, maxRetries: 10, delayMs: 4000, errorStatus: 529 }]);
    stage(liveStatus(live, t, clock), null);
    expect(screen.getByTestId("turn-status").textContent).toBe("Retrying 2/10");
    cleanup();
    live = frame(qc, [{ kind: "status", status: "compacting" }]);
    stage(liveStatus(live, t, clock), null);
    expect(screen.getByTestId("turn-status").textContent).toBe("Compacting context");
    live = frame(qc, [{ kind: "compacted", trigger: "auto", preTokens: 167_000, postTokens: 21_000 }, { kind: "status", status: null }]);
    expect(liveStatus(live, t, clock)).toBe("Retrying 2/10");
    live = frame(qc, [{ kind: "message", id: "m2", parent: null }]);
    expect(liveStatus(live, t, clock)).toBeNull();
  });

  it("says until when a rate limit holds it", () => {
    const qc = new QueryClient();
    const live = frame(qc, [{ kind: "rateLimit", status: "rejected", resetsAt: 1_794_904_200, limit: "five_hour" }]);
    expect(liveStatus(live, t, clock)).toBe(`Rate limited until ${clock(1_794_904_200)}`);
  });

  it("moves the context meter as the context fills", () => {
    const qc = new QueryClient();
    let live = frame(qc, [{ kind: "context", used: null, window: 1_000_000 }, { kind: "context", used: 30_743, window: null }]);
    expect(contextShare(live)).toBe(3);
    live = frame(qc, [{ kind: "context", used: 512_000, window: null }]);
    expect(contextShare(live)).toBe(51);
    stage(null, contextShare(live));
    expect(screen.getByTestId("context-meter").textContent).toBe("51% context");
  });
});

describe("the suggestion the turn ends with", () => {
  it("is a chip under the composer that fills the box", () => {
    const qc = new QueryClient();
    const live = frame(qc, [{ kind: "ended", reason: "completed" }, { kind: "suggestion", text: "Run the tests again" }]);
    render(<ChatComposer onSend={async () => {}} suggestion={live?.suggestion ?? null} />);
    fireEvent.click(screen.getByTestId("suggestion-chip"));
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("Run the tests again");
    expect(screen.queryByTestId("suggestion-chip")).toBeNull();
  });
});

describe("a subagent under the Agent call that spawned it", () => {
  it("opens to its own tool calls", () => {
    render(
      <ToolCall
        tool={{
          id: "toolu_a",
          name: "Agent",
          input: { description: "Count entries" },
          result: "6 entries",
          subagent: [{ type: "tool", tool: { id: "toolu_b", name: "Bash", input: { command: "ls" }, result: "a\nb" } }, { type: "text", text: "6 entries in /work." }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "2 steps" }));
    const nested = screen.getByTestId("subagent");
    expect(nested.textContent).toContain("ls");
    expect(nested.textContent).toContain("6 entries in /work.");
  });
});
