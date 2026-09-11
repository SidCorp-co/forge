// @vitest-environment jsdom

/**
 * The two behaviours the component test cannot reach, because it mocks this
 * module wholesale: what a refused answer does to the cached round, and when
 * the panel goes back to the server without being told to.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayOnReconnect } from "@/lib/ws/event-router";
import type { AgentQuestion, QuestionListResponse } from "./types";

const listForIssue = vi.fn();
const answer = vi.fn();
vi.mock("./api", () => ({
  questionsApi: {
    listForIssue: (issueId: string) => listForIssue(issueId),
    answer: (input: unknown) => answer(input),
  },
}));
const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

const { useAnswerQuestion, useIssueQuestions } = await import("./hooks");

function aQuestion(round: number): AgentQuestion {
  return {
    id: "q-1",
    projectId: "p-1",
    issueId: "i-1",
    status: "open",
    blockerKind: "human",
    steps: [
      {
        round,
        prompt: `round ${round}`,
        options: [],
        recommendedOptionId: "",
        askedAt: "2026-09-11T09:00:00.000Z",
      },
    ],
    maxRounds: 3,
    voidReason: null,
    endedReason: null,
    parkDeadlineAt: null,
    createdAt: "2026-09-11T09:00:00.000Z",
    updatedAt: "2026-09-11T09:00:00.000Z",
    options: [],
    recommendedOptionId: "",
  };
}

const empty: QuestionListResponse = { questions: [] };

let qc: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  listForIssue.mockReset();
  answer.mockReset();
  toast.mockReset();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a refusal sends the screen back to the server", () => {
  // cm:guard every refusal core raises on this path — stale round, already answered, expired, voided — means the cached round is behind the row. Without this refetch the person is looking at a decision the server has moved past and every further click earns the same refusal (ISS-980 criterion 19).
  it("refetches the round after the answer is refused", async () => {
    listForIssue.mockResolvedValueOnce({ questions: [aQuestion(1)] });
    listForIssue.mockResolvedValue({ questions: [aQuestion(2)] });
    const view = renderHook(() => useIssueQuestions("i-1"), { wrapper });
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    expect(view.result.current.data?.questions[0]?.steps[0]?.round).toBe(1);

    answer.mockRejectedValueOnce(new Error("the round you were shown has been superseded"));
    const mutation = renderHook(() => useAnswerQuestion("i-1"), { wrapper });
    mutation.result.current.mutate({ questionId: "q-1", optionId: "o-1", round: 1 });

    await waitFor(() =>
      expect(view.result.current.data?.questions[0]?.steps[0]?.round).toBe(2),
    );
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ tone: "error", description: expect.stringMatching(/superseded/) }),
    );
  });

  it("refetches the round after the answer is recorded", async () => {
    listForIssue.mockResolvedValue({ questions: [aQuestion(1)] });
    renderHook(() => useIssueQuestions("i-1"), { wrapper });
    await waitFor(() => expect(listForIssue).toHaveBeenCalledTimes(1));

    answer.mockResolvedValueOnce(aQuestion(1));
    const mutation = renderHook(() => useAnswerQuestion("i-1"), { wrapper });
    mutation.result.current.mutate({ questionId: "q-1", optionId: "o-1", round: 1 });

    await waitFor(() => expect(listForIssue).toHaveBeenCalledTimes(2));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });
});

describe("the poll is bounded by whether there is anything to poll for", () => {
  // cm:guard the empty case must NOT poll: `agent_questions` carries no index on `issue_id`, so an unconditional interval puts a sequential scan behind every open issue screen. The first question reaches an open screen through `lib/ws/event-router.ts` instead (ISS-980).
  it("does not go back to the server for an issue that carries no question", async () => {
    vi.useFakeTimers();
    listForIssue.mockResolvedValue(empty);
    renderHook(() => useIssueQuestions("i-1"), { wrapper });
    await vi.waitFor(() => expect(listForIssue).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(180_000);
    expect(listForIssue).toHaveBeenCalledTimes(1);
  });

  it("goes back for a follow-up round once the issue carries one", async () => {
    vi.useFakeTimers();
    listForIssue.mockResolvedValue({ questions: [aQuestion(1)] });
    renderHook(() => useIssueQuestions("i-1"), { wrapper });
    await vi.waitFor(() => expect(listForIssue).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(31_000);
    expect(listForIssue.mock.calls.length).toBeGreaterThan(1);
  });

  // cm:guard the reconnect is the ONLY recovery an empty panel has, because the poll above is deliberately off for it: a screen open across a dropped connection missed the `issue.statusChanged` frame that would have carried its first question, and nothing else on this key fires (ISS-980).
  it("picks up a first question missed across a dropped connection", async () => {
    listForIssue.mockResolvedValueOnce(empty);
    listForIssue.mockResolvedValue({ questions: [aQuestion(1)] });
    const view = renderHook(() => useIssueQuestions("i-1"), { wrapper });
    await waitFor(() => expect(view.result.current.data).toEqual(empty));

    replayOnReconnect(qc);

    await waitFor(() => expect(view.result.current.data?.questions).toHaveLength(1));
  });
});
