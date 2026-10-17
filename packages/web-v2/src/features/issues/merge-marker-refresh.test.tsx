// @vitest-environment jsdom
//
// ISS-1421 r4 — the refusal at the release gate sends the reader to Mark merged. Judge-32 marked an
// issue there and the page's banner kept saying "not marked merged", with no Release now, until a
// reload: the mark refreshed the issue but not the release roster the banner reads, nor the comment
// thread its own comment lands in. Every query here is cached for ever, so only an invalidation can
// move what the screen shows.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const ISSUE = "5fb7e758-e403-4568-bebb-b568260ff175";
const PROJECT = "11111111-1111-4111-8111-111111111111";

/** What the server holds: the mark, an open question, and the comments the mark writes. */
const server = { merged: false, question: false, comments: [] as string[] };

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function refusals() {
  return [
    ...(server.merged
      ? []
      : [
          {
            code: "CLOSE_REQUIRES_SHIPPED",
            reason: "not marked merged",
            clears: "Use Mark merged in the issue's properties.",
            said: "It is not marked merged. Use Mark merged in the issue's properties.",
          },
        ]),
    ...(server.question
      ? [
          {
            code: "OPEN_QUESTIONS",
            reason: "holds 1 open question",
            clears: "Answer it in its card.",
            said: "It holds 1 open question. Answer it in its card.",
          },
        ]
      : []),
  ];
}

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    issuesApi: {
      ...actual.issuesApi,
      markMerged: vi.fn(async () => {
        server.merged = true;
        server.comments.push("Marked merged.");
        return { id: ISSUE, action: "merged" as const };
      }),
      unmarkMerged: vi.fn(async () => {
        server.merged = false;
        server.comments.push("Merge mark removed.");
        return { id: ISSUE, action: "unmarked" as const };
      }),
    },
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
            mergedAt: server.merged ? "2026-10-17T09:00:00.000Z" : null,
            waitingDays: 0,
            claimedByRunId: null,
            closeRefusals: refusals(),
            closeFailure: null,
          },
        ],
      })),
    },
  };
});

const { useMergeMarker } = await import("./hooks");
const { AwaitingReleaseBanner } = await import("./components/awaiting-release-banner");

afterEach(() => {
  cleanup();
  server.merged = false;
  server.question = false;
  server.comments = [];
});

/** The thread is read under the issue's comments key, as the page's comment tab reads it. */
function Thread() {
  const q = useQuery({ queryKey: ["comments", ISSUE], queryFn: async () => [...server.comments] });
  return <p data-testid="thread">{(q.data ?? []).join(" ")}</p>;
}

function Page() {
  const marker = useMergeMarker(ISSUE);
  return (
    <div>
      <AwaitingReleaseBanner projectId={PROJECT} issueId={ISSUE} canWrite />
      <Thread />
      <button type="button" onClick={() => marker.mark({ target: "main" })}>
        mark
      </button>
      <button type="button" onClick={() => marker.unmark()}>
        unmark
      </button>
    </div>
  );
}

function mount(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  const wrap = (node: ReactNode) => <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
  render(wrap(<Page />));
}

const releaseNow = () => screen.queryByRole("button", { name: "Release now" });

describe("Mark merged at the release gate (ISS-1421 r4)", () => {
  it("drops the not-merged banner and offers Release now without a reload", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/not marked merged/)).toBeInTheDocument());
    expect(releaseNow()).toBeNull();

    await act(async () => screen.getByRole("button", { name: "mark" }).click());

    await waitFor(() => expect(releaseNow()).toBeInTheDocument());
    expect(screen.queryByText(/not marked merged/)).toBeNull();
  });

  it("keeps a question that still holds the issue, and offers no Release now", async () => {
    server.question = true;
    mount();
    await waitFor(() => expect(screen.getByText(/not marked merged/)).toBeInTheDocument());

    await act(async () => screen.getByRole("button", { name: "mark" }).click());

    await waitFor(() => expect(screen.queryByText(/not marked merged/)).toBeNull());
    expect(screen.getByText(/holds 1 open question/)).toBeInTheDocument();
    expect(releaseNow()).toBeNull();
  });

  it("shows the comment the mark wrote without a reload", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("thread")).toBeInTheDocument());
    await act(async () => screen.getByRole("button", { name: "mark" }).click());
    await waitFor(() => expect(screen.getByTestId("thread")).toHaveTextContent("Marked merged."));
  });

  it("puts the not-merged banner back, and shows Unmark's comment, as soon as Unmark is answered", async () => {
    server.merged = true;
    mount();
    await waitFor(() => expect(releaseNow()).toBeInTheDocument());

    await act(async () => screen.getByRole("button", { name: "unmark" }).click());

    await waitFor(() => expect(screen.getByText(/not marked merged/)).toBeInTheDocument());
    expect(releaseNow()).toBeNull();
    await waitFor(() => expect(screen.getByTestId("thread")).toHaveTextContent("Merge mark removed."));
  });
});
