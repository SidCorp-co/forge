// @vitest-environment jsdom
//
// ISS-1381 r3 — the comment a release leaves on an issue it could not close says: answer the
// question in its Decision waiting card, then press Release now. The banner offering Release now
// reads the release roster, so an answer that leaves the roster cached leaves the banner saying the
// question is still open, with no Release now, until something else refetches it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const ISSUE = "5fb7e758-e403-4568-bebb-b568260ff175";
const PROJECT = "11111111-1111-4111-8111-111111111111";

/** What the server holds: one open question, which is the close's only refusal. */
const server = { answered: false };

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

vi.mock("./api", () => ({
  questionsApi: {
    answer: vi.fn(async () => {
      server.answered = true;
      return {};
    }),
  },
}));

vi.mock("../issues/api", async () => {
  const actual = await vi.importActual<typeof import("../issues/api")>("../issues/api");
  return {
    ...actual,
    releaseBatchApi: {
      ...actual.releaseBatchApi,
      roster: vi.fn(async () => ({
        gateStatus: "awaiting_release",
        nextCutAt: null,
        channels: [],
        releaseRunnerLabel: null,
        baseBranch: "main",
        issues: [
          {
            id: ISSUE,
            displayId: "ISS-5",
            title: "A thing",
            mergedAt: "2026-10-07T09:00:00.000Z",
            waitingDays: 0,
            claimedByRunId: null,
            closeRefusals: server.answered
              ? []
              : [{ code: "OPEN_QUESTIONS", reason: "holds 1 open question", clears: "Answer it." }],
          },
        ],
      })),
    },
  };
});

const { useAnswerQuestion } = await import("./hooks");
const { useReleaseRoster } = await import("../issues/hooks");

afterEach(() => {
  cleanup();
  server.answered = false;
});

describe("answering a question on an issue at the release gate", () => {
  it("refreshes the release roster, so the banner drops the refusal and offers Release now", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({ roster: useReleaseRoster(PROJECT), answer: useAnswerQuestion(ISSUE) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.roster.data).toBeDefined());
    expect(result.current.roster.data?.issues[0]?.closeRefusals).toHaveLength(1);

    await act(async () => {
      await result.current.answer.mutateAsync({ questionId: "q-1", text: "acme", round: 1 });
    });

    await waitFor(() => expect(result.current.roster.data?.issues[0]?.closeRefusals).toEqual([]));
  });
});
