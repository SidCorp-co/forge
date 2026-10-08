// A turn in flight is drawn in the view core sent this reader (REQ-32 criterion 6). The person it
// answers sees the draft labelled "Draft, not yet checked" until the verdict swaps it for the reply
// that went out, or takes it back; every other reader is sent only that it works and its tools by
// name and time, and the thread draws exactly that.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationMessage, ConversationProgressEntry, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

const asked: ConversationMessage = {
  id: "m1",
  seq: 1,
  role: "user",
  authorUserId: "u-asker",
  authorLabel: "Asker",
  content: "How far along is REQ-4?",
  silenceReason: null,
  createdAt: "2026-10-08T03:46:00Z",
};

const open: ConversationWindow = {
  id: "w1",
  firstSeq: 1,
  lastSeq: 1,
  closedAt: null,
  decision: null,
  decisionDetail: null,
};

const DRAFT = "REQ-4 is 90% done, three of four criteria agreed.";
const CHECKED = "REQ-4 has three of its four criteria agreed.";

const call = { id: "t1", name: "forge_show", input: { label: "90% done" }, output: '{"ok":true}', durationMs: 420 };

function asker(over: Partial<ConversationProgressEntry> & { text: string }): ConversationProgressEntry {
  const { text, ...rest } = over;
  return {
    conversationId: "c1",
    rev: 3,
    view: "asker",
    entry: {
      id: "e1",
      type: "assistant",
      timestamp: Date.parse("2026-10-08T03:46:05Z"),
      content: text,
      blocks: [{ type: "tool", toolCall: call }, ...(text ? [{ type: "text" as const, text }] : [])],
    },
    ...rest,
  };
}

const room: ConversationProgressEntry = {
  conversationId: "c1",
  rev: 3,
  view: "room",
  entry: { id: "e1", type: "assistant", timestamp: Date.parse("2026-10-08T03:46:05Z"), content: "", blocks: [] },
  tools: [
    { id: "t1", name: "forge_show", done: true, durationMs: 420 },
    { id: "t2", name: "forge", done: false },
  ],
};

describe("the asker's live turn", () => {
  it("labels the streaming draft as not yet checked", () => {
    render(<ConversationThread messages={[asked]} windows={[open]} progress={asker({ text: DRAFT })} />);
    const live = screen.getByTestId("thread-live-turn");
    expect(live.getAttribute("data-live-view")).toBe("asker");
    expect(screen.getByTestId("thread-live-draft").textContent).toContain("Draft, not yet checked");
    expect(live.textContent).toContain(DRAFT);
  });

  it("swaps the draft for the checked reply on the verdict, the label going with it", () => {
    const { rerender } = render(
      <ConversationThread messages={[asked]} windows={[open]} progress={asker({ text: DRAFT })} />,
    );
    rerender(
      <ConversationThread
        messages={[asked]}
        windows={[open]}
        progress={asker({ text: CHECKED, rev: 4, verdict: "checked" })}
      />,
    );
    const live = screen.getByTestId("thread-live-turn");
    expect(screen.queryByTestId("thread-live-draft")).toBeNull();
    expect(live.textContent).toContain(CHECKED);
    expect(live.textContent).not.toContain(DRAFT);
  });

  it("takes the draft back when nothing of it went out, and says so", () => {
    render(
      <ConversationThread
        messages={[asked]}
        windows={[open]}
        progress={asker({ text: "", rev: 4, verdict: "withheld" })}
      />,
    );
    expect(screen.queryByTestId("thread-live-draft")).toBeNull();
    expect(screen.getByTestId("thread-live-withheld").textContent).toBe("This draft was not sent.");
    expect(screen.getByTestId("thread-live-turn").textContent).not.toContain(DRAFT);
  });

  it("shows no label over a turn that has streamed no prose yet", () => {
    render(<ConversationThread messages={[asked]} windows={[open]} progress={asker({ text: "" })} />);
    expect(screen.queryByTestId("thread-live-draft")).toBeNull();
  });
});

describe("another member's view of the same turn", () => {
  it("draws that the turn works and its tools by name and time, and no text or input at all", () => {
    render(<ConversationThread messages={[asked]} windows={[open]} progress={room} />);
    const live = screen.getByTestId("thread-live-turn");
    expect(live.getAttribute("data-live-view")).toBe("room");
    expect(live.textContent).toContain("The assistant is working on a reply.");
    const tools = screen.getAllByTestId("thread-live-tool").map((li) => li.textContent);
    expect(tools).toEqual(["forge_show420ms", "forgerunning"]);
    expect(screen.queryByTestId("thread-live-draft")).toBeNull();
    expect(live.textContent).not.toContain("90% done");
  });
});
