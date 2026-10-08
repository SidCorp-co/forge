// A stored answer with report blocks is drawn in the conversation thread: its table with links into
// the project, its source naming the query and the moment it was read as core stored them from the
// run, and a block this screen cannot draw named in place, never dropped.

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

const run = { runId: "run-9", queryId: "progress-by-requirement", version: 1, asOf: "2026-10-08T03:46:58.000Z" };

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
            { type: "visual", visual: block, run },
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

  it("shows each block's query and read time, as the run it was drawn from stored them", () => {
    render(
      <ConversationThread projectSlug="forge-dev" messages={[answer([{ type: "visual", visual: block, run }])]} windows={[window1]} />,
    );
    const note = screen.getByTestId("visual-block-source");
    expect(note.textContent).toContain("Report run run-9");
    expect(screen.getByTestId("visual-block-query").textContent).toBe("progress-by-requirement");
    expect(note.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-08T03:46:58.000Z");
  });

  it("refuses a stored block whose run's query and read time were not stored with it, by name", () => {
    render(<ConversationThread projectSlug="forge-dev" messages={[answer([{ type: "visual", visual: block }])]} windows={[window1]} />);
    expect(screen.getByTestId("visual-block-refused").textContent).toContain("report run run-9: its query and read time were not stored");
    expect(screen.queryByRole("link", { name: "REQ-4" })).toBeNull();
  });

  it("does not lend one block's run to another's", () => {
    const other = { ...block, source: { runId: "run-10" } };
    render(
      <ConversationThread
        projectSlug="forge-dev"
        messages={[answer([{ type: "visual", visual: block, run }, { type: "visual", visual: other }])]}
        windows={[window1]}
      />,
    );
    expect(screen.getAllByTestId("visual-block-source")).toHaveLength(1);
    expect(screen.getByTestId("visual-block-refused").textContent).toContain("report run run-10");
  });
});
