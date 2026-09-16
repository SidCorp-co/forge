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

expect.extend(matchers);
afterEach(cleanup);

const asked: ConversationMessage = {
  id: "m0",
  seq: 0,
  role: "user",
  authorUserId: "alice",
  authorLabel: "Alice",
  content: "is the release ready?",
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
