import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

// A reply another member's turn wrote reaches this reader with its tool calls' inputs and outputs
// taken out by core (packages/core/src/conversations/tool-content.ts). The thread draws each such
// call by name and time and says whose it is, rather than "no output", and offers no act from it.

afterEach(cleanup);

const window1: ConversationWindow = { id: "w1", firstSeq: 1, lastSeq: 2, closedAt: "2026-10-08T03:48:00Z", decision: null, decisionDetail: null };

const reply = {
  id: "m2",
  seq: 2,
  role: "assistant",
  authorUserId: null,
  authorLabel: null,
  content: "REQ-4 has three of four criteria agreed.",
  blocks: [
    { type: "thinking", durationMs: 1200 },
    { type: "tool", toolCall: { id: "c1", name: "forge_project_status", durationMs: 420, withheld: true } },
    { type: "tool", toolCall: { id: "c2", name: "offer_act", durationMs: 35, withheld: true } },
    { type: "text", text: "REQ-4 has three of four criteria agreed." },
  ],
  silenceReason: null,
  createdAt: "2026-10-08T03:47:00Z",
} as unknown as ConversationMessage;

describe("a reply another member asked for", () => {
  it("draws its tools by name and time, says they are the asker's, and offers no act", () => {
    renderWithQuery(<ConversationThread projectId="p1" messages={[reply]} windows={[window1]} />);
    expect(screen.getAllByText("Shown only to the person who asked").length).toBeGreaterThan(0);
    expect(screen.queryByText("No output recorded")).toBeNull();
    expect(screen.getByText("REQ-4 has three of four criteria agreed.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /admit|open|release/i })).toBeNull();
  });
});
