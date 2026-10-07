// An owner's ruling is recorded as a decision, apart from the thread's chatter (dev.55): the composer's
// Decision mode asks for what is decided and why, sends them as fields with intent `decision` so core
// writes the body every agent reads, and a decision in the thread wears its own badge.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";
import type { CommentNode } from "../types";
import { CommentThread } from "./comment-thread";

const decided = {
  id: "c1",
  body: "**Decision:** ship behind the flag\n\n**Reason:** the migration is not reversible",
  intent: "decision",
  decision: { decision: "ship behind the flag", reason: "the migration is not reversible" },
  createdAt: "2026-10-06T00:00:00Z",
  authorId: "u1",
  replies: [],
  attachments: [],
} as unknown as CommentNode;

async function openDecisionMode() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Decision" }));
  const box = await screen.findByTestId("record-decision");
  return { user, box };
}

describe("recording a decision on an issue", () => {
  it("cannot be sent until both what is decided and why are written", async () => {
    const calls = fakeCore(() => undefined);
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    const send = within(box).getByRole("button", { name: "Record decision" });
    expect(send).toBeDisabled();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship behind the flag");
    expect(send).toBeDisabled();
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "   ");
    expect(send).toBeDisabled();
    expect(calls).toEqual([]);
  });

  it("sends the fields with intent decision, not a body of its own", async () => {
    const calls = fakeCore(() => ({ status: 201, body: decided }));
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "  ship behind the flag ");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "the migration is not reversible");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: "/issues/i1/comments",
        body: { intent: "decision", decision: { decision: "ship behind the flag", reason: "the migration is not reversible" } },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("record-decision")).toBeNull());
  });

  it("names a refusal by its detail and keeps what was written", async () => {
    fakeCore(() => ({
      status: 403,
      body: { error: { code: "COMMENT_REFUSED", message: "refused", refusals: [{ code: "DECISION_NOT_ALLOWED", path: "", detail: "only a person may record a decision" }] } },
    }));
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship it");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "because");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    expect(await within(box).findByRole("alert")).toHaveTextContent("only a person may record a decision");
    expect(within(box).getByRole("textbox", { name: "Decision" })).toHaveValue("ship it");
  });
});

// HOP ISS-120 and ISS-67 (dev, 2026-10-07): a decision sent while dev answered slowly was lost when the
// page closed three seconds later, before core had read the request. The request outlives the page,
// and leaving while it is in flight asks first.
describe("a decision still being recorded", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function sendHeld() {
    fakeCore(() => HANG);
    renderWithQuery(<CommentThread issueId="i1" comments={[]} members={[]} />);
    const { user, box } = await openDecisionMode();
    await user.type(within(box).getByRole("textbox", { name: "Decision" }), "ship it");
    await user.type(within(box).getByRole("textbox", { name: "Reason" }), "because");
    await user.click(within(box).getByRole("button", { name: "Record decision" }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
  }

  it("is sent as a request that outlives the page", async () => {
    await sendHeld();
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.keepalive).toBe(true);
  });

  it("asks before the page is left while it is in flight", async () => {
    await sendHeld();
    const leaving = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });
});

describe("a decision in the thread", () => {
  it("wears the Decision badge", () => {
    fakeCore(() => undefined);
    renderWithQuery(<CommentThread issueId="i1" comments={[decided]} members={[]} readOnly />);
    expect(screen.getByText("Decision")).toBeInTheDocument();
  });
});
