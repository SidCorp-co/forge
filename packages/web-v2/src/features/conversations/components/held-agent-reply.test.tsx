// An Agent reply the reply check held stays reachable (dev, 2026-10-08): the room reads that it was
// held and why, and the person it answered can open the reply as the session wrote it, marked as held,
// with the visual blocks the session drew for it (REQ-32 criteria 5 and 6) — and nobody else sees them.

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

const turn = (reply: string | null, blocks?: NonNullable<AgentTurn["held"]>["blocks"]): AgentTurn => ({
  windowId: "w1",
  sessionId: "s1",
  state: "held",
  reason: null,
  held: { reason: REASON, reply, ...(blocks !== undefined ? { blocks } : {}) },
});

const heldTable = {
  type: "visual" as const,
  visual: {
    v: 1,
    kind: "status-list",
    ref: "key",
    status: "state",
    source: { runId: "run-9" },
    frame: {
      fields: [
        { name: "key", type: "ref", label: "Item" },
        { name: "state", type: "status", label: "State" },
      ],
      rows: [{ key: "REQ-4", state: "agreed" }],
    },
  },
  run: { runId: "run-9", queryId: "progress-by-requirement", version: 1, asOf: "2026-10-08T03:46:58.000Z" },
};

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

  it("draws the blocks held with the reply only inside the opened disclosure, never in the thread", () => {
    render(
      <ConversationThread
        projectSlug="forge-dev"
        messages={[asked]}
        windows={[handed]}
        agentTurns={[turn("Here is where it stands.", [heldTable])]}
      />,
    );
    expect(screen.queryByTestId("thread-held-blocks")).toBeNull();
    expect(screen.queryByRole("link", { name: "REQ-4" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show the held reply" }));
    const blocks = screen.getByTestId("thread-held-blocks");
    expect(screen.getByTestId("thread-held-reply").contains(blocks)).toBe(true);
    expect(screen.getByRole("link", { name: "REQ-4" }).getAttribute("href")).toBe("/projects/forge-dev/requirements/REQ-4");
  });

  it("gives a reader the reply was not written for neither the reply nor its blocks", () => {
    render(<ConversationThread messages={[asked]} windows={[handed]} agentTurns={[turn(null, null)]} />);
    expect(screen.queryByRole("button", { name: "Show the held reply" })).toBeNull();
    expect(screen.queryByTestId("thread-held-blocks")).toBeNull();
  });
});
