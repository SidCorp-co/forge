// A stored answer with report blocks is drawn in the conversation thread: its table with links into
// the project, and a block this screen cannot draw named in place, never dropped.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationMessage, ConversationWindow } from "../types";
import { ConversationThread } from "./conversation-thread";

afterEach(cleanup);

const block = {
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
};

const answer = (blocks: unknown[]): ConversationMessage =>
  ({
    id: "m2",
    seq: 2,
    role: "assistant",
    authorUserId: null,
    authorLabel: null,
    content: "Here is where it stands.",
    blocks,
    silenceReason: null,
    createdAt: "2026-10-08T03:47:00Z",
  }) as unknown as ConversationMessage;

const window1: ConversationWindow = {
  id: "w1",
  firstSeq: 1,
  lastSeq: 2,
  closedAt: "2026-10-08T03:47:10Z",
  decision: null,
  decisionDetail: null,
};

describe("a stored answer holding report blocks", () => {
  it("draws the block with its links, and names the one it cannot draw and the one that breaks its shape, between its prose", () => {
    render(
      <ConversationThread
        projectSlug="forge-dev"
        messages={[
          answer([
            { type: "text", text: "Here is where it stands." },
            { type: "visual", visual: block },
            { type: "unsupported", unsupported: "hologram" },
            { type: "visual", visual: { v: 1, kind: "flow" } },
          ]),
        ]}
        windows={[window1]}
      />,
    );
    expect(screen.getByRole("link", { name: "REQ-4" }).getAttribute("href")).toBe("/projects/forge-dev/requirements/REQ-4");
    expect(screen.getAllByTestId("visual-block-unsupported").map((n) => n.textContent)).toEqual([
      "This answer has a hologram block this screen cannot show.",
    ]);
    expect(screen.getByTestId("visual-block-refused").textContent).toContain("This answer has a flow block that does not match its shape");
  });
});
