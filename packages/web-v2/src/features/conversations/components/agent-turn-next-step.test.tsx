// A failed Agent turn shows the next step its own cause calls for (REQ-30 BC-9, ISS-440): a box that
// cannot confine a chat is never answered with "ask again to start a fresh session", and a turn whose
// cause names no step of its own keeps the generic one.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentTurn, ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

const asked: ConversationMessage = {
  id: "m1",
  seq: 1,
  role: "user",
  authorUserId: "u1",
  authorLabel: "Owner",
  content: "Where does the export break?",
  silenceReason: null,
  createdAt: "2026-10-08T12:00:00Z",
};

const handed: ConversationWindow = {
  id: "w1",
  firstSeq: 1,
  lastSeq: 1,
  closedAt: "2026-10-08T12:00:05Z",
  decision: "handed-off",
  decisionDetail: null,
};

const CONFINE_NEXT =
  "The box holder can run `forge-runner doctor` on that box to see what is missing: a chat runs confined only on Linux with bubblewrap (`bwrap`) installed and a current forge-runner (`forge-runner update`). Until then, ask in Assistant mode for anything that does not need the repository.";

const failed = (reason: string, nextStep: string | null): AgentTurn => ({
  windowId: "w1",
  sessionId: "s1",
  state: "failed",
  reason,
  nextStep,
  held: null,
});

describe("a failed Agent turn's next step", () => {
  it("is the one its cause names: a box that cannot confine tells its holder what to do, not to ask again", () => {
    render(
      <ConversationThread
        messages={[asked]}
        windows={[handed]}
        agentTurns={[failed("the runner box mac-mini cannot confine one, so nothing was dispatched: runs macos.", CONFINE_NEXT)]}
      />,
    );
    const entry = screen.getByTestId("thread-agent-turn");
    expect(entry.textContent).toContain("mac-mini cannot confine one");
    expect(screen.getByTestId("thread-agent-turn-next").textContent).toBe(CONFINE_NEXT);
    expect(entry.textContent).not.toMatch(/Ask again to start a fresh session/);
  });

  it("keeps the generic step where the cause names none of its own", () => {
    render(
      <ConversationThread messages={[asked]} windows={[handed]} agentTurns={[failed("the session ended failed", null)]} />,
    );
    expect(screen.getByTestId("thread-agent-turn-next").textContent).toMatch(/^Ask again to start a fresh session/);
  });
});
