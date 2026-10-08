// The live QA (2026-10-08) had an owner ruling to record on REQ-32 and no place to put it: the
// requirement page had no comment act, so the ruling went onto two of its issues as questions. A
// requirement's thread now takes a question, a note or a decision, each sent by its intent, and
// draws a decision apart from the talk.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { EntityCommentThread } from "./entity-comment-thread";

const LIST = "/projects/p1/requirements/REQ-32/comments";

const comment = (id: string, intent: "question" | "note" | "decision", at: string, over: object = {}) => ({
  id,
  target: { scope: "requirement", id: "r1", key: "REQ-32", title: "Reports" },
  intent,
  body: intent === "decision" ? null : `${intent} ${id}`,
  format: "markdown",
  decision: intent === "decision" ? { decision: "Sandbox runs only on ZDR providers", reason: "R1, owner ruling" } : null,
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

describe("a requirement's comment thread", () => {
  it("lists every comment newest first, a decision behind its accent bar", async () => {
    fakeCore((c) =>
      c.path === LIST
        ? {
            body: {
              comments: [
                comment("a", "question", "2026-10-08T09:00:00Z"),
                comment("b", "decision", "2026-10-08T11:00:00Z"),
                comment("c", "note", "2026-10-08T10:00:00Z"),
              ],
              returned: 3,
            },
          }
        : undefined,
    );
    renderWithQuery(<EntityCommentThread projectId="p1" scope="requirement" targetRef="REQ-32" />);
    const decision = await screen.findByTestId("thread-decision");
    expect(decision).toHaveTextContent("Sandbox runs only on ZDR providers");
    expect(decision).toHaveTextContent("R1, owner ruling");
    const talk = screen.getAllByTestId("entity-comment");
    expect(talk.map((li) => li.textContent?.includes("note c"))).toEqual([true, false]);
    expect(within(talk[1] as HTMLElement).getByText("Question")).toBeInTheDocument();
  });

  it("sends a note by default and a question when Question is picked", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET") return { body: { comments: [], returned: 0 } };
      return { status: 201, body: { comment: comment("n", "note", "2026-10-08T12:00:00Z") } };
    });
    const user = userEvent.setup();
    renderWithQuery(<EntityCommentThread projectId="p1" scope="requirement" targetRef="REQ-32" />);
    expect(await screen.findByText("No comments yet.")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("Add a note…"), "  Checked against the HOP walk. ");
    await user.click(screen.getByRole("button", { name: "Post note" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: LIST, body: { intent: "note", body: "Checked against the HOP walk." } }));
    await user.click(screen.getByRole("button", { name: "Question" }));
    await user.type(screen.getByPlaceholderText("Ask a question…"), "Is BC-12 still in scope?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "POST", path: LIST, body: { intent: "question", body: "Is BC-12 still in scope?" } }));
  });

  it("records a decision with its reason as fields", async () => {
    const calls = fakeCore((c) => {
      if (c.method === "GET") return { body: { comments: [], returned: 0 } };
      return { status: 201, body: { comment: comment("d", "decision", "2026-10-08T12:00:00Z") } };
    });
    const user = userEvent.setup();
    renderWithQuery(<EntityCommentThread projectId="p1" scope="requirement" targetRef="REQ-32" />);
    await user.click(await screen.findByRole("button", { name: "Decision" }));
    const form = await screen.findByTestId("decision-composer");
    await user.type(within(form).getByRole("textbox", { name: "Decision" }), "Sandbox runs only on ZDR providers");
    await user.type(within(form).getByRole("textbox", { name: "Reason" }), "R1, owner ruling");
    await user.click(within(form).getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: LIST,
        body: { intent: "decision", decision: { decision: "Sandbox runs only on ZDR providers", reason: "R1, owner ruling" } },
      }),
    );
  });

  it("shows core's refusal by name and keeps what was written", async () => {
    fakeCore((c) => {
      if (c.method === "GET") return { body: { comments: [], returned: 0 } };
      return {
        status: 403,
        body: { error: { code: "PERMISSION_FORBIDDEN", message: "refused", refusals: [{ code: "PERMISSION_FORBIDDEN", path: "", detail: "commenting needs project.write on this project" }] } },
      };
    });
    const user = userEvent.setup();
    renderWithQuery(<EntityCommentThread projectId="p1" scope="requirement" targetRef="REQ-32" />);
    await user.type(await screen.findByPlaceholderText("Add a note…"), "a note");
    await user.click(screen.getByRole("button", { name: "Post note" }));
    expect(await screen.findByTestId("entity-comment-refusal")).toHaveTextContent("commenting needs project.write");
    expect(screen.getByPlaceholderText("Add a note…")).toHaveValue("a note");
  });
});
