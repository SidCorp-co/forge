// REQ-41 BC-2: each decision the needs-me read answers shows its question, the recommended answer
// and why, and a button that answers it; pressing posts the button's own body to the route the
// record's page calls, as the person. The chat draws the same list from a `forge_needs_you` result.

import type { NeedsYouDecisions } from "@forge/contracts/needs-you-decisions";
import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { DecisionList } from "./components/decision-list";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const PROJECT = "6f0ee160-8432-4b84-98cf-956b6cd65a29";
const Q = "8d2a3f5e-21c4-4b8e-9d62-6a4e3c1f0b77";

const READ: NeedsYouDecisions = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-09T12:00:00.000Z",
  total: 2,
  decisions: [
    {
      group: "answer",
      area: "issues",
      entity: "issue",
      key: "ISS-1",
      title: "Export",
      opens: { kind: "issue", key: "ISS-1" },
      question: "Keep the old export format or move to the new one?",
      recommended: { answerId: "move", why: 'Whoever asked recommends "Move to the new one".', by: "asker" },
      noRecommendation: null,
      answers: [
        { id: "move", label: "Move to the new one", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "move" }, needsReason: false, effect: "Sends this answer to the run that asked.", recommended: true },
        { id: "keep", label: "Keep the old format", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "keep" }, needsReason: false, effect: null, recommended: false },
      ],
      touchedAt: "2026-10-08T10:00:00.000Z",
    },
    {
      group: "approve",
      area: "requirements",
      entity: "requirement",
      key: "REQ-1",
      title: "Checkout",
      opens: { kind: "requirement", key: "REQ-1" },
      question: "Accept revision 2 of REQ-1, or return it to its author?",
      recommended: { answerId: "accept", why: "Its author proposed revision 2 for sign-off.", by: "rule" },
      noRecommendation: null,
      answers: [
        { id: "accept", label: "Accept revision 2", act: "revision.accept", path: `/api/projects/${PROJECT}/requirements/REQ-1/revisions/2/accept`, body: {}, needsReason: false, effect: null, recommended: true },
        { id: "return", label: "Return with a reason", act: "revision.return", path: `/api/projects/${PROJECT}/requirements/REQ-1/revisions/2/return`, body: {}, needsReason: true, effect: null, recommended: false },
      ],
      touchedAt: "2026-10-08T11:00:00.000Z",
    },
  ],
  notDecisions: [
    { reason: "awaiting_proposal", count: 37, keys: ["ISS-4"] },
    { reason: "own_work", count: 2, keys: ["REQ-2", "REQ-3"] },
  ],
});

afterEach(() => vi.unstubAllGlobals());

describe("the decisions only you can make (REQ-41 BC-2)", () => {
  it("shows each question with its recommended answer and why, under its group, and names what was left out", () => {
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    const rows = screen.getAllByTestId("needs-you-decision");
    expect(rows.map((r) => r.getAttribute("data-group"))).toEqual(["answer", "approve"]);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByTestId("needs-you-decision-question")).toHaveTextContent("Keep the old export format or move to the new one?");
    expect(within(first).getByTestId("needs-you-decision-recommended")).toHaveTextContent('Recommended: Move to the new one. Whoever asked recommends "Move to the new one".');
    expect(within(first).getAllByTestId("needs-you-decision-answer").map((b) => b.textContent)).toEqual(["Move to the new one", "Keep the old format"]);
    expect(within(first).getByRole("link", { name: "ISS-1" })).toHaveAttribute("href", "/projects/hop/issues/ISS-1");
    expect(screen.getByTestId("needs-you-left-out")).toHaveTextContent(
      "Left out, not decisions: 37 drafts nobody has proposed merging or dropping yet, 2 of your own drafts to finish.",
    );
  });

  it("posts the button's own body to its route as the person, and says it was sent", async () => {
    const calls = fakeCore(() => ({ body: { ok: true } }));
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    fireEvent.click(screen.getByRole("button", { name: "Move to the new one" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sent: Move to the new one"));
    expect(calls).toEqual([{ method: "POST", path: `/questions/${Q}/answer`, body: { round: 1, optionId: "move" } }]);
  });

  it("asks the reason first where the act takes one, and sends it under `reason`", async () => {
    const calls = fakeCore(() => ({ body: { ok: true } }));
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    fireEvent.click(screen.getByRole("button", { name: "Return with a reason" }));
    expect(calls).toEqual([]);
    fireEvent.change(screen.getByTestId("needs-you-decision-typed"), { target: { value: "BC-3 is not what I asked" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      method: "POST",
      path: `/projects/${PROJECT}/requirements/REQ-1/revisions/2/return`,
      body: { reason: "BC-3 is not what I asked" },
    });
  });

  it("shows the route's own refusal where the press is refused", async () => {
    fakeCore(() => ({ status: 409, body: { error: { code: "QUESTION_NOT_OPEN", message: "the question was answered already" } } }));
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept revision 2" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the question was answered already"));
  });
});
