// ISS-281 / FB-16: a feedback item's suggested triage was accepted at one click with no reason, and
// its History showed only the agent's note under the decision the accept wrote. Accept now opens a
// confirm step that sends the person's reason, and the History shows it under that decision.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { FeedbackView } from "../types";
import { Proposals } from "./feedback-actions";
import { FeedbackHistory } from "./feedback-detail";

afterEach(() => vi.unstubAllGlobals());

const item = (over: Partial<FeedbackView> = {}): FeedbackView =>
  ({
    id: "f1",
    key: "FB-1",
    can: { triage: true, verify: false, reopen: false, askVerify: false, redact: false, retarget: false },
    openSuggestions: 1,
    decisions: [],
    ...over,
  }) as unknown as FeedbackView;

const triage = {
  id: "s9",
  kind: "feedback_triage",
  status: "proposed",
  target: { type: "feedback", id: "f1" },
  baseRevision: null,
  payload: { route: "issue", note: "Same as the board crash" },
  producerKind: "agent",
  model: null,
  createdAt: "2026-10-06T17:00:00.000Z",
};

describe("accepting a suggested triage", () => {
  it("opens a confirm step, sends nothing on Cancel, and sends the typed reason on Accept", async () => {
    const calls = fakeCore((c) => (c.method === "GET" ? { body: { suggestions: [triage], open: 1 } } : { body: { suggestion: { ...triage, status: "accepted" } } }));
    renderWithQuery(<Proposals projectId="p1" f={item()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const step = screen.getByTestId("accept-step");
    expect(step).toHaveTextContent("Accepting routes the item: Issue");
    fireEvent.click(within(step).getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.change(within(screen.getByTestId("accept-step")).getByRole("textbox", { name: "Why it is accepted, and on whose authority" }), {
      target: { value: "Support lead confirmed" },
    });
    fireEvent.click(within(screen.getByTestId("accept-step")).getByRole("button", { name: "Accept" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === "POST")).toEqual([
        { method: "POST", path: "/projects/p1/suggestions/s9/accept", body: { reason: "Support lead confirmed" } },
      ]),
    );
  });
});

describe("a decision an accepted suggestion wrote, in the History", () => {
  const decision = {
    decision: "triaged",
    route: "issue",
    carrier: "ISS-4",
    reason: "Same as the board crash",
    decidedBy: "u1",
    decidedByName: "Ana",
    decidedAgency: "human",
    decidedAt: "2026-10-06T17:05:00.000Z",
    fromSuggestionId: "s9",
  };

  it("shows the person's accept reason beside the agent's note", () => {
    renderWithQuery(<FeedbackHistory f={item({ decisions: [{ ...decision, acceptReason: "Support lead confirmed" }] } as Partial<FeedbackView>)} />);
    const row = within(screen.getByTestId("feedback-history")).getAllByRole("listitem")[0] as HTMLElement;
    expect(row).toHaveTextContent("Same as the board crash");
    expect(row).toHaveTextContent("Accepted: Support lead confirmed");
  });

  it("shows no accept line where the accept carried no reason", () => {
    renderWithQuery(<FeedbackHistory f={item({ decisions: [{ ...decision, acceptReason: null }] } as Partial<FeedbackView>)} />);
    expect(screen.getByTestId("feedback-history")).not.toHaveTextContent("Accepted:");
  });
});
