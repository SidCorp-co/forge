// REQ-10 r4 BC-6 / BC-7: the card asks only its open questions; what the code suggested is listed
// as assumptions, read-only with their evidence, and an assumption the person changes goes in the
// same one send as the answers.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";
import type { QuestionnaireItemView, QuestionnaireView } from "../types";
import { Questionnaire } from "./questionnaire";

const item = (id: string, over: Partial<QuestionnaireItemView>): QuestionnaireItemView => ({
  id,
  group: "question",
  control: "choice",
  prompt: `Which store keeps ${id}?`,
  options: [
    { id: "pg", label: "Postgres" },
    { id: "redis", label: "Redis" },
  ],
  inferredDefault: "pg",
  why: "The designs differ.",
  evidence: ["apps/api/src/store.ts:Store"],
  affects: [],
  questionId: `q-${id}`,
  state: "open",
  answer: null,
  answeredBy: null,
  answeredAt: null,
  ...over,
});

const batch: QuestionnaireView = {
  id: "b1",
  conversationId: "c1",
  onboardingId: "o1",
  requirementId: null,
  firstRequirementsOf: null,
  title: "What the code cannot answer",
  intro: null,
  round: 1,
  maxRounds: 3,
  status: "open",
  items: [
    item("sessions", {}),
    item("orders", {
      group: "assumption",
      state: "answered",
      answer: { choice: "pg" },
      answeredBy: "agent-1",
      answeredAt: "2026-10-21T00:00:00.000Z",
      evidence: ["apps/api/src/orders.ts:OrderTable"],
    }),
  ],
  answered: 1,
  open: 1,
  postedBy: "agent-1",
  postedAt: "2026-10-21T00:00:00.000Z",
  submittedBy: null,
  submittedAt: null,
  skippedAt: null,
  supersededAt: null,
  supersededBy: null,
  messageId: null,
  answersMessageId: null,
  sensitiveData: "off",
};

describe("the questionnaire card's assumptions", () => {
  it("lists each assumption read-only with what was assumed and its evidence, apart from the questions", () => {
    fakeCore(() => undefined);
    renderWithQuery(<Questionnaire projectId="p1" batch={batch} />);
    const row = screen.getByTestId("questionnaire-assumption");
    expect(row).toHaveTextContent("Which store keeps orders?");
    expect(row).toHaveTextContent("Postgres");
    expect(row).toHaveTextContent("apps/api/src/orders.ts:OrderTable");
    expect(within(row).queryByText("Redis")).toBeNull();
    expect(screen.getByText("Answered 0 of 1")).toBeInTheDocument();
  });

  it("sends a changed assumption in the same one send as an answer", async () => {
    const calls = fakeCore(() => ({ body: { questionnaire: batch } }));
    const user = userEvent.setup();
    renderWithQuery(<Questionnaire projectId="p1" batch={batch} />);
    const row = screen.getByTestId("questionnaire-assumption");
    await user.click(within(row).getByRole("button", { name: "Change" }));
    await user.click(within(row).getByText("Redis"));
    await user.click(screen.getByRole("button", { name: "Send answers" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({
      answers: [{ itemId: "orders", choice: "redis" }],
    });
  });
});
