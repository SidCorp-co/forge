// A workflow has no comment thread of its own, so the questions people raised on it — through the old
// Questions desk or any door sending intent question — read on its Decisions view beside the decisions
// made on it (REQ-33 BC-8), each owed until someone other than its asker replies.

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { WorkflowDecisions } from "./workflow-decisions";

const LIST = "/projects/p1/workflows/w-intake/comments";
const at = "2026-10-15T09:00:00Z";
const comment = (id: string, over: object) => ({
  id,
  target: { scope: "workflow", id: "w-intake", key: "intake", title: "Intake" },
  intent: "question",
  body: "",
  format: "markdown",
  decision: null,
  writtenLang: null,
  parentId: null,
  author: { id: "u1", name: "Dana", agency: "human" },
  withheld: false,
  edited: false,
  createdAt: at,
  updatedAt: at,
  datedAhead: null,
  ...over,
});

describe("a workflow's Decisions view", () => {
  it("reads the questions raised on the workflow beside its decisions", async () => {
    fakeCore((c) => {
      if (c.path === LIST) return { body: { comments: [comment("q1", { body: "Does intake take a referral by phone?" })], returned: 1 } };
      if (c.path === `${LIST}?intent=decision`) return { body: { comments: [], returned: 0 } };
      return undefined;
    });
    renderWithQuery(<WorkflowDecisions projectId="p1" workflowId="w-intake" />);
    const section = await screen.findByTestId("raised-questions-section");
    const row = within(section).getByTestId("raised-question");
    expect(row).toHaveTextContent("Does intake take a referral by phone?");
    expect(row).toHaveAttribute("data-state", "owed");
  });
});
