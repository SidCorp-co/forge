// A question a person raised as a comment on a feedback item or a workflow — through the old Questions
// desk, or any door that sends intent question — stays readable on the item it is about (REQ-33 BC-8):
// each with who asked and when, owed until someone other than its asker replies, then that reply.

import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { RaisedQuestions } from "./raised-questions";

const comment = (id: string, intent: "question" | "note" | "decision", at: string, over: object = {}) => ({
  id,
  target: { scope: "workflow", id: "w1", key: "intake", title: "Intake" },
  intent,
  body: `${intent} ${id}`,
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

const LIST = "/projects/p1/workflows/intake/comments";

describe("questions raised on an item", () => {
  it("lists each raised question, owed until someone else replies, then with that reply", async () => {
    fakeCore((c) =>
      c.path === LIST
        ? {
            body: {
              comments: [
                comment("q1", "question", "2026-10-08T09:00:00Z", { body: "Does intake take a referral by phone?" }),
                comment("r0", "note", "2026-10-08T09:30:00Z", { parentId: "q1", body: "Still checking." }),
                comment("r1", "note", "2026-10-08T10:00:00Z", { parentId: "q1", body: "Yes, the clinic logs it.", author: { id: "u2", name: "Lan", agency: "human" } }),
                comment("q2", "question", "2026-10-09T09:00:00Z", { body: "Who triages a weekend referral?" }),
                comment("n1", "note", "2026-10-09T10:00:00Z"),
              ],
              returned: 5,
            },
          }
        : undefined,
    );
    renderWithQuery(<RaisedQuestions projectId="p1" scope="workflow" targetRef="intake" />);
    const rows = await screen.findAllByTestId("raised-question");
    const answered = rows[1];
    if (!answered) throw new Error("no second question is drawn");
    expect(rows.map((r) => r.dataset.state)).toEqual(["owed", "answered"]);
    expect(rows[0]).toHaveTextContent("Who triages a weekend referral?");
    expect(rows[1]).toHaveTextContent("Does intake take a referral by phone?");
    expect(within(answered).getByTestId("raised-answer")).toHaveTextContent("Yes, the clinic logs it.");
    expect(within(answered).getByTestId("raised-answer")).toHaveTextContent("Lan");
    expect(rows[1]).not.toHaveTextContent("Still checking.");
    expect(screen.queryByText("note n1")).toBeNull();
  });

  it("draws nothing where nobody raised a question", async () => {
    fakeCore((c) => (c.path === LIST ? { body: { comments: [comment("n1", "note", "2026-10-09T10:00:00Z")], returned: 1 } } : undefined));
    const { container } = renderWithQuery(<RaisedQuestions projectId="p1" scope="workflow" targetRef="intake" />);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("[data-testid=raised-questions-section]")).toBeNull();
  });
});
