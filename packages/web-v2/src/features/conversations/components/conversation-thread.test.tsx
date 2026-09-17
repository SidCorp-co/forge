// @vitest-environment jsdom
//
// ISS-1004 criterion 28, on the screen rather than in the deriver: a person
// reading a conversation can tell a turn that said nothing from a turn that was
// never taken. `types.test.ts` proves the two produce different entries; this
// proves the two entries reach the page as different text, which is where the
// criterion's own word "reading" puts it.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTurn, ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";
import { Conversation } from "@/features/session/components/conversation";
import { parseMessages } from "@/features/session/types";

expect.extend(matchers);
afterEach(cleanup);

const asked: ConversationMessage = {
  id: "m0",
  seq: 0,
  role: "user",
  authorUserId: "alice",
  authorLabel: "Alice",
  content: "is the release ready?",
  blocks: null,
  silenceReason: null,
  createdAt: "2026-09-14T00:00:00.000Z",
};

const closed = (decision: ConversationWindow["decision"]): ConversationWindow => ({
  id: "w1",
  firstSeq: 0,
  lastSeq: 0,
  closedAt: "2026-09-14T00:00:01.000Z",
  decision,
  decisionDetail: null,
});

describe("ConversationThread", () => {
  it("shows what was said", () => {
    render(<ConversationThread messages={[asked]} windows={[]} />);
    expect(screen.getByText("is the release ready?")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("names the reason a settled turn said nothing", () => {
    render(<ConversationThread messages={[asked]} windows={[closed("guard-dormant")]} />);
    const silence = screen.getByTestId("thread-silence");
    expect(silence).toHaveTextContent(/no person has spoken here for a long time/i);
    expect(silence).toHaveTextContent("guard-dormant");
    expect(screen.queryByTestId("thread-pending")).toBeNull();
  });

  it("says a turn has not been taken, in different words and a different element", () => {
    render(
      <ConversationThread
        messages={[asked]}
        windows={[{ ...closed(null), closedAt: null }]}
      />,
    );
    expect(screen.getByTestId("thread-pending")).toHaveTextContent(/nobody has answered this yet/i);
    expect(screen.queryByTestId("thread-silence")).toBeNull();
  });

  // cm:guard a message row carrying `silence_reason` is a turn that RAN and declined, and it is a THIRD state beside the two above — the window may well be `answered`, because the silence itself was the answer. Rendering it as an empty assistant bubble is how it used to be invisible.
  it("renders a recorded silence as a silence rather than an empty bubble", () => {
    render(
      <ConversationThread
        messages={[
          asked,
          { ...asked, id: "m1", seq: 1, role: "assistant", content: "", silenceReason: "nothing-to-say", authorLabel: null },
        ]}
        windows={[closed("answered")]}
      />,
    );
    expect(screen.getByText(/The agent said nothing here/)).toBeInTheDocument();
  });

  // cm:guard criterion 19, and it is asserted on what REACHES THE PAGE rather than on the type: the
  // browser threw `blocks` away at the boundary, so no renderer could have drawn a tool card however
  // it was written. What proves the consumption is a tool card in the document for a row whose
  // blocks carry one — the thing the content-only path could not produce for any input (ISS-1078).
  it("draws a stored turn's tool blocks as cards", () => {
    const answer: ConversationMessage = {
      ...asked,
      id: "m1",
      seq: 1,
      role: "assistant",
      authorLabel: null,
      content: "there are two open issues.",
      blocks: [
        { type: "tool", toolCall: { id: "t1", name: "forge_issues", input: { status: "open" } } },
        { type: "text", text: "there are two open issues." },
      ],
    };
    render(<ConversationThread messages={[asked, answer]} windows={[closed("answered")]} />);
    expect(screen.getByText("there are two open issues.")).toBeInTheDocument();
    expect(screen.getByText(/forge_issues/)).toBeInTheDocument();
  });

  // cm:guard criterion 12: a row written before ISS-1029 carries `blocks: null` and is a text-only
  // row. It renders as its text and NOT as an empty turn — which is what a renderer that reached
  // only for blocks would draw, and is indistinguishable on screen from an answer that never came.
  it("renders a row whose blocks are null as its text", () => {
    const legacy: ConversationMessage = {
      ...asked,
      id: "m1",
      seq: 1,
      role: "assistant",
      authorLabel: null,
      content: "the release went out on Tuesday.",
      blocks: null,
    };
    render(<ConversationThread messages={[asked, legacy]} windows={[closed("answered")]} />);
    expect(screen.getByText("the release went out on Tuesday.")).toBeInTheDocument();
  });

  // cm:guard criteria 3, 4 and 5 on the screen: the turn being written is drawn from the frame the
  // socket carried, with its tool card, while the room's own rows hold nothing about it yet.
  it("draws the turn that is being written right now", () => {
    render(
      <ConversationThread
        messages={[asked]}
        windows={[{ ...closed(null), closedAt: null }]}
        progress={{
          conversationId: "c1",
          entry: {
            id: "entry-1",
            type: "assistant",
            blocks: [
              { type: "tool", toolCall: { id: "t1", name: "forge_issues", input: {} } },
              { type: "text", text: "looking now" },
            ],
          },
        }}
      />,
    );
    expect(screen.getByTestId("thread-live-turn")).toBeInTheDocument();
    expect(screen.getByText("looking now")).toBeInTheDocument();
    expect(screen.getByText(/forge_issues/)).toBeInTheDocument();
  });

  // cm:guard criterion 11 on the screen: the live frames and the durable row are ONE turn under one
  // id, so once the row is in the room the live copy goes. Drawing both would show a person their
  // answer twice for as long as the settle took.
  it("drops the live turn once its own durable row is in the room", () => {
    const answer: ConversationMessage = {
      ...asked,
      id: "entry-1",
      seq: 1,
      role: "assistant",
      authorLabel: null,
      content: "there are two.",
      blocks: null,
    };
    render(
      <ConversationThread
        messages={[asked, answer]}
        windows={[closed("answered")]}
        progress={{
          conversationId: "c1",
          entry: { id: "entry-1", type: "assistant", content: "there are two." },
        }}
      />,
    );
    expect(screen.queryByTestId("thread-live-turn")).toBeNull();
    expect(screen.getAllByText("there are two.")).toHaveLength(1);
  });

  // cm:guard criterion 16, and it is about what happens when NO further frame arrives: a browser
  // whose socket went mid-turn is left holding a half-written turn and never sees the settle. What
  // brings it back is the durable row and the shared entry id — the live copy is dropped because
  // its own row turned up, not because anything told it to. That is the reduction criterion 11
  // buys, doing the work of a signal that never came.
  it("shows the finished answer to a browser left holding a half-written turn", () => {
    const stale = {
      conversationId: "c1",
      entry: { id: "entry-1", type: "assistant", content: "there are t" },
    };
    const { rerender } = render(
      <ConversationThread
        messages={[asked]}
        windows={[{ ...closed(null), closedAt: null }]}
        progress={stale}
      />,
    );
    expect(screen.getByTestId("thread-live-turn")).toHaveTextContent("there are t");

    // The room is read again — a reconnect, a reload, a poll — and the answer is in it.
    rerender(
      <ConversationThread
        messages={[
          asked,
          {
            ...asked,
            id: "entry-1",
            seq: 1,
            role: "assistant",
            authorLabel: null,
            content: "there are two open issues.",
            blocks: null,
          },
        ]}
        windows={[closed("answered")]}
        progress={stale}
      />,
    );
    expect(screen.queryByTestId("thread-live-turn")).toBeNull();
    expect(screen.getByText("there are two open issues.")).toBeInTheDocument();
  });

  // cm:guard criterion 7: the caret trails the live turn and stops trailing it when the turn is
  // over. `Conversation` draws it on the last text block of the tail only while `streaming` is set,
  // so the property asserted is that a STORED turn is not passed it — a thread that always streamed
  // would leave a caret blinking under every answer in the room's history.
  it("trails the live turn with a caret and leaves stored turns without one", () => {
    const { container, rerender } = render(
      <ConversationThread
        messages={[asked]}
        windows={[{ ...closed(null), closedAt: null }]}
        progress={{
          conversationId: "c1",
          entry: { id: "entry-1", type: "assistant", content: "there are t" },
        }}
      />,
    );
    expect(container.querySelectorAll(".forge-caret")).toHaveLength(1);

    rerender(
      <ConversationThread
        messages={[
          asked,
          { ...asked, id: "entry-1", seq: 1, role: "assistant", authorLabel: null, content: "there are t", blocks: null },
        ]}
        windows={[closed("answered")]}
      />,
    );
    expect(container.querySelectorAll(".forge-caret")).toHaveLength(0);
    expect(screen.getByText("there are t")).toBeInTheDocument();
  });

  // cm:guard the caret stops on a REPLACEMENT too, and for a reason of its own: the turn is over —
  // this text is the reply that went out — so a caret still trailing it would say the agent was
  // about to write more, under the one sentence it definitely will not change.
  it("stops the caret on a replacement", () => {
    const { container } = render(
      <ConversationThread
        messages={[asked]}
        windows={[{ ...closed(null), closedAt: null }]}
        progress={{
          conversationId: "c1",
          replaced: true,
          entry: { id: "entry-1", type: "assistant", content: "the sentence that went out" },
        }}
      />,
    );
    expect(container.querySelectorAll(".forge-caret")).toHaveLength(0);
  });

  // cm:guard criterion 8 on the screen, and the half the amnesty is paid with: the replacement is
  // announced as a replacement. A thread that simply showed the new sentence would be the silent
  // substitution the owner's decision refuses by name.
  it("says so when a refused draft was replaced", () => {
    render(
      <ConversationThread
        messages={[asked]}
        windows={[{ ...closed(null), closedAt: null }]}
        progress={{
          conversationId: "c1",
          replaced: true,
          entry: { id: "entry-1", type: "assistant", content: "the sentence that went out" },
        }}
      />,
    );
    expect(screen.getByTestId("thread-correction")).toHaveTextContent(/replaced what it was writing/i);
    expect(screen.getByText("the sentence that went out")).toBeInTheDocument();
  });

  // cm:guard criterion 15: a fourth on-screen state — in flight, with partial content — must not be
  // confusable with the three `threadEntries` already tells apart. This asserts all four are present
  // and distinct in one render, because each read alone passes on a screen that collapsed them.
  it("keeps the live turn distinct from pending, from a silence and from an answer", () => {
    const answered: ConversationMessage = {
      ...asked,
      id: "m1",
      seq: 1,
      role: "assistant",
      authorLabel: null,
      content: "the release went out.",
      blocks: null,
    };
    render(
      <ConversationThread
        messages={[asked, answered, { ...asked, id: "m2", seq: 2, content: "and the next?" }]}
        windows={[
          closed("answered"),
          { ...closed("nothing-to-say"), id: "w2", firstSeq: 1, lastSeq: 1 },
          { ...closed(null), id: "w3", firstSeq: 2, lastSeq: 2, closedAt: null },
        ]}
        progress={{
          conversationId: "c1",
          entry: { id: "entry-9", type: "assistant", content: "reading the issues" },
        }}
      />,
    );
    expect(screen.getByTestId("thread-pending")).toHaveTextContent(/nobody has answered this yet/i);
    expect(screen.getByTestId("thread-silence")).toHaveTextContent(/had nothing to add/i);
    expect(screen.getByText("the release went out.")).toBeInTheDocument();
    expect(screen.getByTestId("thread-live-turn")).toHaveTextContent("reading the issues");
  });

  // cm:guard criterion 1 on the screen: the row a person just typed stops saying "Sending…" the
  // moment the server has filed it, and it is still there — the label goes, the words do not.
  it("drops the Sending label on an accepted row without dropping the row", () => {
    render(
      <ConversationThread
        messages={[]}
        windows={[]}
        outbox={[{ id: "o1", content: "is the release ready?", state: "accepted" }]}
      />,
    );
    expect(screen.getByText("is the release ready?")).toBeInTheDocument();
    expect(screen.queryByText("Sending…")).toBeNull();
  });

  // cm:guard asserted by test id AND by the absence of the assistant renderer's text: a system line that came out as a bubble would still contain the text, so the text alone proves nothing (ISS-1034 criterion 48).
  it("renders a system row as one muted line, not as an assistant bubble", () => {
    const joined: ConversationMessage = {
      ...asked,
      id: "m9",
      seq: 9,
      role: "system",
      authorUserId: null,
      authorLabel: "system",
      content: "bob@example.com joined; this room is now a group.",
    };
    render(<ConversationThread messages={[asked, joined]} windows={[]} />);
    const line = screen.getByTestId("thread-system");
    expect(line).toHaveTextContent("bob@example.com joined; this room is now a group.");
    expect(line.tagName).toBe("P");
    expect(line.closest("[class*='rounded-lg']")).toBeNull();
  });

  // cm:guard ISS-1039 criteria 19 to 22 — a runner-hosted turn is four different things on screen,
  // and the two that owe the person something are `failed` and only `failed`: which failure it was,
  // and what to do about it. A single grey line reading "agent" for all four is the blank thread
  // this feature exists to remove, and it passes any assertion made on the test id alone — so each
  // case here reads the SENTENCE.
  describe("a turn handed to a paired box", () => {
    const handed: ConversationWindow = { ...closed("handed-off") };
    const turn = (over: Partial<AgentTurn> = {}): AgentTurn => ({
      windowId: "w1",
      sessionId: "s1",
      state: "dispatched",
      reason: null,
      ...over,
    });

    it("says a dispatched turn is waiting to be picked up", () => {
      render(
        <ConversationThread messages={[asked]} windows={[handed]} agentTurns={[turn()]} />,
      );
      const row = screen.getByTestId("thread-agent-turn");
      expect(row).toHaveAttribute("data-agent-turn-state", "dispatched");
      expect(row).toHaveTextContent(/waiting for one to pick it up/);
    });

    it("says a running turn is being worked on, in different words", () => {
      render(
        <ConversationThread
          messages={[asked]}
          windows={[handed]}
          agentTurns={[turn({ state: "running" })]}
        />,
      );
      const row = screen.getByTestId("thread-agent-turn");
      expect(row).toHaveAttribute("data-agent-turn-state", "running");
      expect(row).toHaveTextContent(/A session is working on this/);
      expect(row).not.toHaveTextContent(/waiting for one to pick it up/);
    });

    it("shows a delivered turn as its reply and not as a label saying one arrived", () => {
      render(
        <ConversationThread
          messages={[
            asked,
            {
              ...asked,
              id: "m1",
              seq: 1,
              role: "assistant",
              authorUserId: null,
              authorLabel: null,
              content: "two issues left",
            },
          ]}
          windows={[handed]}
          agentTurns={[turn({ state: "delivered" })]}
        />,
      );
      expect(screen.queryByTestId("thread-agent-turn")).not.toBeInTheDocument();
      expect(screen.getByText("two issues left")).toBeInTheDocument();
    });

    it("tells a failed turn which failure it was, and what to do next", () => {
      render(
        <ConversationThread
          messages={[asked]}
          windows={[handed]}
          agentTurns={[
            turn({ state: "failed", reason: "the session ended before it answered" }),
          ]}
        />,
      );
      const row = screen.getByTestId("thread-agent-turn");
      expect(row).toHaveAttribute("data-agent-turn-state", "failed");
      expect(row).toHaveTextContent("the session ended before it answered");
      expect(row).toHaveTextContent(/Ask again to start a fresh session/);
    });

    // cm:guard the one sentence this thread must NEVER print over a live turn: "sent and never
    // confirmed" is what a `handed-off` window read as before it had a branch of its own, and it
    // tells a person their answer is lost while a box is still working on it (criterion 27).
    it("never reads a live turn as a reply that was sent and never confirmed", () => {
      for (const state of ["dispatched", "running", "failed"] as const) {
        cleanup();
        render(
          <ConversationThread messages={[asked]} windows={[handed]} agentTurns={[turn({ state })]} />,
        );
        expect(screen.queryByText(/sent and never confirmed/)).toBeNull();
      }
    });
  });
});

// cm:guard criterion 13, and it is asserted by COMPARING the two renders rather than by reading the
// import: a thread that reached for `Conversation` and then wrapped its output in a second layout
// would satisfy the import and still draw a different turn. Two markups that differ is the drift
// ISS-1029 exists to prevent, arriving one wrapper at a time.
describe("the chat thread and a runner session", () => {
  const blocks = [
    { type: "tool" as const, toolCall: { id: "t1", name: "forge_issues", input: { status: "open" } } },
    { type: "text" as const, text: "there are two open issues." },
  ];
  const entry = { id: "entry-1", type: "assistant", content: "there are two open issues.", blocks };

  it("draw the same canonical entry identically", () => {
    const thread = render(
      <ConversationThread
        messages={[
          {
            ...asked,
            id: "entry-1",
            seq: 1,
            role: "assistant",
            authorLabel: null,
            content: "there are two open issues.",
            blocks,
          },
        ]}
        windows={[]}
      />,
    );
    const fromThread = thread.container.querySelector("[class*='max-w-']")?.outerHTML;
    cleanup();

    const session = render(<Conversation items={parseMessages([entry])} readOnly />);
    const fromSession = session.container.querySelector("[class*='max-w-']")?.outerHTML;

    expect(fromThread).toBeTruthy();
    expect(fromThread).toBe(fromSession);
  });
});
