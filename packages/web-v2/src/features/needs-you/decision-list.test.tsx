// REQ-41 BC-2: each decision the needs-me read answers shows its question, the recommended answer
// and why, and a button that answers it; pressing posts the button's own body to the route the
// record's page calls, as the person. The chat draws the same list from a `forge_needs_you` result.

import type { NeedsYouDecisions } from "@forge/contracts/needs-you-decisions";
import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import { DecisionList } from "./components/decision-list";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));

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
      changes: "What happens next on it",
      impact: "It waits on this until it is decided.",
      recommended: { answerId: "move", why: 'Whoever asked recommends "Move to the new one".', by: "asker" },
      noRecommendation: null,
      answers: [
        { id: "move", label: "Move to the new one", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "move" }, needsReason: false, declines: false, effect: "Sends this answer to the run that asked.", recommended: true },
        { id: "keep", label: "Keep the old format", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "keep" }, needsReason: false, declines: false, effect: null, recommended: false },
      ],
      touchedAt: "2026-10-08T10:00:00.000Z",
      stuck: false,
      dueAt: null,
      id: "d1",
      topic: "question",
      proposal: null,
    },
    {
      group: "approve",
      area: "requirements",
      entity: "requirement",
      key: "REQ-1",
      title: "Checkout",
      opens: { kind: "requirement", key: "REQ-1" },
      question: "Accept revision 2 of REQ-1, or return it to its author?",
      changes: "What happens next on it",
      impact: "It waits on this until it is decided.",
      recommended: { answerId: "accept", why: "BC-2 keeps a referral's notes — The ward lead asked for it", by: "rule" },
      noRecommendation: null,
      answers: [
        { id: "accept", label: "Accept revision 2", act: "revision.accept", path: `/api/projects/${PROJECT}/requirements/REQ-1/revisions/2/accept`, body: { reason: "BC-2 keeps a referral's notes — The ward lead asked for it" }, needsReason: true, declines: false, effect: null, recommended: true },
        { id: "return", label: "Return with a reason", act: "revision.return", path: `/api/projects/${PROJECT}/requirements/REQ-1/revisions/2/return`, body: {}, needsReason: true, declines: true, effect: null, recommended: false },
      ],
      touchedAt: "2026-10-08T11:00:00.000Z",
      stuck: false,
      dueAt: null,
      id: "d2",
      topic: "question",
      proposal: null,
    },
  ],
  notDecisions: [
    { reason: "awaiting_proposal", count: 37, items: [{ key: "ISS-4", title: "ISS-4", next: null, opens: null }] },
    { reason: "own_work", count: 2, items: [{ key: "REQ-2", title: "REQ-2", next: null, opens: null }, { key: "REQ-3", title: "REQ-3", next: null, opens: null }] },
  ],
});

afterEach(() => vi.unstubAllGlobals());

describe("the decisions only you can make (REQ-41 BC-2)", () => {
  it("shows each question with its recommended answer and why, under its group, and names what was left out", () => {
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    const rows = screen.getAllByTestId("needs-you-decision");
    expect(rows.map((r) => r.getAttribute("data-group"))).toEqual(["answer", "approve"]);
    const first = rows[0];
    if (!first) throw new Error("no decision row");
    expect(within(first).getByTestId("needs-you-decision-question")).toHaveTextContent("Keep the old export format or move to the new one?");
    expect(within(first).getByTestId("needs-you-decision-recommended")).toHaveTextContent('Recommended: Move to the new one. Whoever asked recommends "Move to the new one".');
    expect(within(first).getAllByTestId("needs-you-decision-answer").map((b) => b.textContent)).toEqual(["Move to the new one", "Keep the old format"]);
    expect(within(first).getByRole("link", { name: "ISS-1" })).toHaveAttribute("href", "/projects/hop/issues/ISS-1");
    expect(screen.getByTestId("needs-you-left-out")).toHaveTextContent(
      "Left out, not decisions: 37 drafts nobody has proposed merging or dropping yet, 2 of your own drafts to finish.",
    );
  });

  it("labels a suggestion the assistant drafted, and sends its text in one click", async () => {
    const text = "Use the clinic code printed on the referral letter.";
    const read = needsYouDecisionsSchema.parse({
      ...READ,
      total: 1,
      decisions: [
        {
          group: "answer",
          area: "issues",
          entity: "issue",
          key: "ISS-1",
          title: "Import",
          opens: { kind: "issue", key: "ISS-1" },
          question: "Which identifier should the referral import match on?",
          changes: "What happens next on it",
          impact: "It waits on this until it is decided.",
          recommended: { answerId: "suggested", why: `"${text}" REQ-1 says referrals match by clinic code. (read ISS-1, REQ-1)`, by: "assistant" },
          noRecommendation: null,
          answers: [
            { id: "suggested", label: "Send the suggested answer", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, text }, needsReason: false, declines: false, effect: null, recommended: true },
            { id: "write", label: "Write another answer", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1 }, needsReason: true, declines: false, effect: null, recommended: false },
          ],
          touchedAt: "2026-10-08T10:00:00.000Z",
          stuck: false,
          dueAt: null,
          id: "d3",
          topic: "question",
          proposal: null,
        },
      ],
      notDecisions: [],
    });
    const calls = fakeCore(() => ({ body: { ok: true } }));
    renderWithQuery(<DecisionList read={read} slug="hop" />);
    const line = screen.getByTestId("needs-you-decision-recommended");
    expect(line).toHaveTextContent("Suggested by the assistant:");
    expect(line).toHaveTextContent(text);
    expect(line).not.toHaveTextContent("Recommended:");
    fireEvent.click(screen.getByRole("button", { name: "Send the suggested answer" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.path === `/questions/${Q}/answer`)).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ round: 1, text });
  });

  // REQ-68 BC-1: what deciding changes and its impact, each said once, as properties of the decision
  it("says what each decision changes and its impact, once each", () => {
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    const first = screen.getAllByTestId("needs-you-decision")[0];
    if (!first) throw new Error("no decision drawn");
    const stakes = within(first).getByTestId("needs-you-decision-stakes");
    expect(stakes).toHaveTextContent("ChangesWhat happens next on itImpactIt waits on this until it is decided.");
    expect(first.textContent?.split("What happens next on it").length).toBe(2);
  });

  // the project home draws each decision dense: what it changes, its impact and the why sit behind the question
  it("draws a dense decision as its question and buttons, the stakes and the why a hover away", () => {
    renderWithQuery(<DecisionList read={READ} slug="hop" dense />);
    const first = screen.getAllByTestId("needs-you-decision")[0];
    if (!first) throw new Error("no decision drawn");
    expect(within(first).queryByTestId("needs-you-decision-stakes")).toBeNull();
    expect(within(first).queryByTestId("needs-you-decision-recommended")).toBeNull();
    expect(within(first).queryByTestId("needs-you-decision-effects")).toBeNull();
    const question = within(first).getByTestId("needs-you-decision-question");
    expect(question.getAttribute("title")).toBe(
      'Keep the old export format or move to the new one?\nChanges: What happens next on it\nImpact: It waits on this until it is decided.\nWhoever asked recommends "Move to the new one".',
    );
    expect(within(first).getByRole("button", { name: "Move to the new one" })).toHaveAttribute("title", "Sends this answer to the run that asked.");
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

  // REQ-68 BC-2, judged short on dev.325 (K98): a recommended answer whose rule takes a reason opened
  // a words box prefilled with the recommendation, and a second press sent it
  it("sends a recommended answer that takes a reason in one press, with the words core gave it", async () => {
    const calls = fakeCore(() => ({ body: { ok: true } }));
    const keep = needsYouDecisionsSchema.parse({
      ...READ,
      total: 1,
      decisions: [
        {
          ...READ.decisions[0],
          question: "Keep ISS-933 or drop it?",
          recommended: { answerId: "keep", why: "It carries open feedback.", by: "steward" },
          answers: [
            { id: "keep", label: "Keep it", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "keep", note: "It carries open feedback." }, needsReason: true, declines: false, effect: "Keeps ISS-933 as it is.", recommended: true },
            { id: "drop", label: "Drop it", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "drop" }, needsReason: true, declines: true, effect: "Drops ISS-933.", recommended: false },
          ],
        },
      ],
    });
    renderWithQuery(<DecisionList read={keep} slug="hop" />);
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId("needs-you-decision-typed")).toBeNull();
    expect(calls[0]).toEqual({
      method: "POST",
      path: `/questions/${Q}/answer`,
      body: { round: 1, optionId: "keep", note: "It carries open feedback." },
    });
  });

  // REQ-68 BC-1, judged red on dev.325 (K98): what an answer does was a hover title, so a phone never showed it
  it("draws what each answer does as text beside the buttons, not only as a hover title", () => {
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    const first = screen.getAllByTestId("needs-you-decision")[0];
    if (!first) throw new Error("no decision drawn");
    expect(within(first).getByTestId("needs-you-decision-effects")).toHaveTextContent(
      "Move to the new one: Sends this answer to the run that asked.",
    );
  });

  it("shows the route's own refusal where the press is refused", async () => {
    fakeCore(() => ({ status: 409, body: { error: { code: "QUESTION_NOT_OPEN", message: "the question was answered already" } } }));
    renderWithQuery(<DecisionList read={READ} slug="hop" />);
    fireEvent.click(screen.getByRole("button", { name: "Accept revision 2" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the question was answered already"));
  });
});
