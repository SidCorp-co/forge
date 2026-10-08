// The HOP journey walk (2026-10-08): a requirement's Decisions tab was a master's pass logs. It
// lists what a person decided, says how many agent records are folded away, and shows them on ask.

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RequirementDecisions } from "./requirement-decisions";

const row = (id: string, text: string, agency: "human" | "agent") => ({
  id,
  target: { scope: "requirement", id: "r1", key: "REQ-25", title: "Roles" },
  intent: "decision",
  body: null,
  format: "markdown",
  decision: { decision: text, reason: "because" },
  parentId: null,
  author: { id: agency === "human" ? "u1" : "a1", name: agency === "human" ? "Dana" : "master", agency },
  withheld: false,
  edited: false,
  createdAt: "2026-10-07T10:00:00Z",
  updatedAt: "2026-10-07T10:00:00Z",
  datedAhead: null,
});

describe("a requirement's Decisions tab", () => {
  it("lists what a person decided, folds what agents kept, and shows it when asked", async () => {
    const calls = fakeCore((c) => {
      if (c.path === "/projects/p1/requirements/REQ-25/decisions") return { body: { decisions: [row("d1", "Roles are checked centrally", "human")], answers: [], by: "people", folded: 12 } };
      if (c.path === "/projects/p1/requirements/REQ-25/decisions?by=all")
        return { body: { decisions: [row("d1", "Roles are checked centrally", "human"), row("d2", "Not dispatched this pass", "agent")], answers: [], by: "all", folded: 0 } };
      if (c.path.startsWith("/projects/p1/requirements/REQ-25/comments")) return { body: { comments: [], returned: 0 } };
      return undefined;
    });
    const user = userEvent.setup();
    renderWithQuery(<RequirementDecisions projectId="p1" slug="hop" reqKey="REQ-25" />);
    await user.click(await screen.findByRole("button", { name: /Decisions/ }));
    expect(await screen.findAllByTestId("decision-row")).toHaveLength(1);
    expect(screen.getByTestId("decisions-folded")).toHaveTextContent("12 records agents kept here");
    await user.click(screen.getByRole("button", { name: "Show them" }));
    await waitFor(() => expect(calls.map((c) => c.path)).toContain("/projects/p1/requirements/REQ-25/decisions?by=all"));
    await waitFor(() => expect(screen.getAllByTestId("decision-row")).toHaveLength(2));
  });
});
