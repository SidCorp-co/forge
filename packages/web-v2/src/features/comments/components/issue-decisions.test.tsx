// REQ-33 BC-2, BC-6 (ISS-432): an issue's Decisions tab lists the decisions recorded on it — what was
// decided, who, when and why, read from each decision record — through the one entity decisions read
// a requirement's and a workflow's use. The issue records a decision in its own thread, so the tab
// offers no second composer.

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { DecisionsPanel } from "./decisions-panel";

const row = {
  id: "d1",
  target: { scope: "issue", id: "i1", key: "ISS-110", title: "Export button" },
  intent: "decision",
  body: "**Decision:** Print it on the header",
  format: "markdown",
  decision: { decision: "Print it on the header", reason: "the clinic asked for it" },
  parentId: null,
  author: { id: "u1", name: "Dana", agency: "human" },
  withheld: false,
  edited: false,
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T10:00:00Z",
  datedAhead: null,
};

afterEach(() => vi.unstubAllGlobals());

describe("an issue's Decisions tab", () => {
  it("reads the issue's decisions through the entity decisions read, with what, who, when and why", async () => {
    const calls = fakeCore((c) => (c.path === "/projects/p1/issues/ISS-110/comments?intent=decision" ? { body: { comments: [row], returned: 1 } } : undefined));
    renderWithQuery(<DecisionsPanel projectId="p1" scope="issue" targetRef="ISS-110" />);
    const decision = await screen.findByTestId("decision-row");
    expect(within(decision).getByText("Print it on the header")).toBeInTheDocument();
    expect(decision).toHaveTextContent("the clinic asked for it");
    expect(decision).toHaveTextContent("Dana");
    expect(calls.map((c) => c.path)).toEqual(["/projects/p1/issues/ISS-110/comments?intent=decision"]);
    expect(screen.queryByTestId("decision-composer")).toBeNull();
  });
});
