// A draft the reply check replaced is never shown again (REQ-32 BC-6): core sends only that it was
// replaced, the router keeps that fact, and the thread draws one line naming the check, with none of
// the withdrawn words, struck through or otherwise.

import type { WsFrame } from "@forge/contracts/ws-frames";
import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConversationThread } from "@/features/conversations/components/conversation-thread";
import type { ConversationMessage, ConversationWindow } from "@/features/conversations/types";
import { routeEvent } from "./event-router";

const DRAFT = "Forge has 4,812 open issues right now.";
const REPLY = "I can't verify that figure from the available report.";

const frame = {
  event: "conversation.progress",
  data: {
    conversationId: "c1",
    rev: 5,
    view: "asker",
    entry: { id: "e1", type: "assistant", content: REPLY, blocks: [{ type: "text", text: REPLY }] },
    verdict: "checked",
    replaced: true,
  },
} as unknown as WsFrame;

const asked: ConversationMessage = {
  id: "m1",
  seq: 1,
  role: "user",
  authorUserId: "u1",
  authorLabel: "Asker",
  content: "How many open issues?",
  silenceReason: null,
  createdAt: "2026-10-09T03:46:00Z",
} as ConversationMessage;
const open: ConversationWindow = { id: "w1", firstSeq: 1, lastSeq: 1, closedAt: null, decision: null, decisionDetail: null };

describe("a replaced draft", () => {
  it("is kept as the fact that it was replaced, with no words", () => {
    const qc = new QueryClient();
    routeEvent(frame, qc);
    expect(qc.getQueryData(["conversations", "c1", "withdrawn"])).toEqual({ e1: true });
    expect(JSON.stringify(qc.getQueryCache().getAll().map((q) => q.state.data))).not.toContain("4,812");
  });

  it("is drawn as one note naming the reply check, and the withdrawn draft is nowhere on screen", () => {
    const qc = new QueryClient();
    routeEvent(frame, qc);
    const withdrawn = qc.getQueryData(["conversations", "c1", "withdrawn"]) as Record<string, true>;
    const { container } = render(
      <ConversationThread
        messages={[asked]}
        windows={[open]}
        withdrawn={withdrawn}
        progress={{
          conversationId: "c1",
          rev: 5,
          view: "asker",
          verdict: "checked",
          entry: { id: "e1", type: "assistant", timestamp: 1, content: REPLY, blocks: [{ type: "text", text: REPLY }] },
        }}
      />,
    );
    expect(screen.getByTestId("thread-reply-withdrawn").textContent).toContain("replaced by the reply check");
    expect(container.textContent).not.toContain(DRAFT);
    expect(container.querySelector(".line-through")).toBeNull();
    expect(container.textContent).toContain(REPLY);
  });
});
