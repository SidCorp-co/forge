// An Agent reply the reply check held stays reachable (dev, 2026-10-08): the room reads that it was
// held and why, and the person it answered can open the reply as the session wrote it, marked as held.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AgentTurn, ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

const asked: ConversationMessage = {
  id: "m1",
  seq: 1,
  role: "user",
  authorUserId: "u1",
  authorLabel: "Owner",
  content: "Make the panel open at its widest by default.",
  silenceReason: null,
  createdAt: "2026-10-08T03:46:00Z",
};

const handed: ConversationWindow = {
  id: "w1",
  firstSeq: 1,
  lastSeq: 1,
  closedAt: "2026-10-08T03:46:10Z",
  decision: "handed-off",
  decisionDetail: null,
};

const REASON = 'It broke the rule "report the result you have, or say exactly what is missing" (no-empty-promise).';

const turn = (reply: string | null): AgentTurn => ({
  windowId: "w1",
  sessionId: "s1",
  state: "held",
  reason: null,
  held: { reason: REASON, reply },
});

describe("a held Agent reply", () => {
  it("reads as held, never as a turn that produced no answer, and opens marked with its reason", () => {
    render(<ConversationThread messages={[asked]} windows={[handed]} agentTurns={[turn("I filed ISS-395 as a draft.")]} />);
    const entry = screen.getByTestId("thread-agent-turn");
    expect(entry.getAttribute("data-agent-turn-state")).toBe("held");
    expect(entry.textContent).toContain("The reply check held the reply this Agent turn wrote.");
    expect(entry.textContent).not.toContain("did not produce an answer");
    expect(screen.queryByTestId("thread-held-reply")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show the held reply" }));
    const held = screen.getByTestId("thread-held-reply");
    expect(held.textContent).toContain(`Held by the reply check: ${REASON}`);
    expect(held.textContent).toContain("I filed ISS-395 as a draft.");
    expect(screen.getByRole("button", { name: "Hide the held reply" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("offers nothing to open to a reader the reply was not written for", () => {
    render(<ConversationThread messages={[asked]} windows={[handed]} agentTurns={[turn(null)]} />);
    expect(screen.getByTestId("thread-agent-turn").getAttribute("data-agent-turn-state")).toBe("held");
    expect(screen.queryByRole("button", { name: "Show the held reply" })).toBeNull();
  });
});
