// REQ-41 BC-2 in chat: a turn that read `forge_needs_you` draws the decisions under its reply from
// the tool's own result, never from the model's words, and nothing from any other tool or a refused call.

import { needsYouDecisionsSchema } from "@forge/contracts/needs-you-decisions";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import { decisionsIn, TurnDecisions } from "./turn-decisions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const Q = "8d2a3f5e-21c4-4b8e-9d62-6a4e3c1f0b77";
const READ = needsYouDecisionsSchema.parse({
  generatedAt: "2026-10-09T12:00:00.000Z",
  total: 1,
  decisions: [
    {
      group: "answer",
      area: "questions",
      entity: "question",
      key: Q,
      title: "Rotate the webhook secret now or at the next release?",
      opens: null,
      question: "Rotate the webhook secret now or at the next release?",
      recommended: { answerId: "later", why: 'Whoever asked recommends "At the next release".', by: "asker" },
      noRecommendation: null,
      answers: [
        { id: "later", label: "At the next release", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "later" }, needsReason: false, effect: null, recommended: true },
        { id: "now", label: "Now", act: "question.answer", path: `/api/questions/${Q}/answer`, body: { round: 1, optionId: "now" }, needsReason: false, effect: null, recommended: false },
      ],
      touchedAt: null,
    },
  ],
  notDecisions: [],
});

const block = (name: string, output: unknown, isError = false) => ({
  type: "tool" as const,
  toolCall: { id: "t1", name, input: {}, output: JSON.stringify(output), isError },
});

describe("the chat draws the decisions its turn read (REQ-41 BC-2)", () => {
  it("reads a forge_needs_you result, and nothing from another tool, a refused call or a stray shape", () => {
    expect(decisionsIn([block("forge_needs_you", READ)] as never)?.total).toBe(1);
    expect(decisionsIn([block("forge_project_status", READ)] as never)).toBeNull();
    expect(decisionsIn([block("forge_needs_you", READ, true)] as never)).toBeNull();
    expect(decisionsIn([block("forge_needs_you", { decisions: "not the read" })] as never)).toBeNull();
  });

  it("renders each decision with its recommended answer and buttons under the turn; a question on nothing opens no link", () => {
    renderWithQuery(<TurnDecisions blocks={[block("forge_needs_you", READ)] as never} slug="hop" />);
    expect(screen.getAllByTestId("needs-you-decision")).toHaveLength(1);
    expect(screen.getByTestId("needs-you-decision-recommended")).toHaveTextContent("Recommended: At the next release.");
    expect(screen.getAllByTestId("needs-you-decision-answer").map((b) => b.textContent)).toEqual(["At the next release", "Now"]);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
