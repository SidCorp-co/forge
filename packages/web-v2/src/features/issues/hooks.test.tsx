// @vitest-environment jsdom
//
// ISS-1381 r4 — two clicks on Release now inside one frame both reached `mutate`, because the
// button's `disabled` waits for a render: the second POST was refused `CLAIM_CONFLICT` and the
// person saw "Batch release failed" beside "Batch release started".

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));

/** Each release the server is asked for answers once the test says so. */
const answers: Array<(value: unknown) => void> = [];
const create = vi.fn(() => new Promise((resolve) => answers.push(resolve)));
const STARTED = { runId: "run-1", issueIds: ["iss-1"], warnings: [] };
async function answerAll() {
  await waitFor(() => expect(answers.length).toBeGreaterThan(0));
  await act(async () => {
    for (const answer of answers.splice(0)) answer(STARTED);
  });
}
const roster = vi.fn();
const search = vi.fn();
vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    issuesApi: { ...actual.issuesApi, search },
    releaseBatchApi: { ...actual.releaseBatchApi, create, roster },
  };
});

const { useBatchRelease, useIssues, useReleaseRoster } = await import("./hooks");

afterEach(() => {
  cleanup();
  create.mockClear();
  roster.mockReset();
  search.mockReset();
  toast.mockClear();
  answers.length = 0;
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("useBatchRelease — Release now pressed twice", () => {
  it("sends one release and shows the person no failure for the second press", async () => {
    const { result } = renderHook(() => useBatchRelease("proj-1"), { wrapper });

    act(() => {
      result.current.mutate({ issueIds: ["iss-1"] });
      result.current.mutate({ issueIds: ["iss-1"] });
    });
    await answerAll();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(create).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ tone: "success" }));
  });

  it("sends again once the first release has answered", async () => {
    const { result } = renderHook(() => useBatchRelease("proj-1"), { wrapper });

    act(() => result.current.mutate({ issueIds: ["iss-1"] }));
    await answerAll();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    act(() => result.current.mutate({ issueIds: ["iss-2"] }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });
});

// ISS-1381 r5 — a refused press left the banner on the roster from before it, so the issue a
// release already held still offered Release now and the next press met the same refusal.
describe("useBatchRelease — Release now refused", () => {
  function rosterWith(claimedByRunId: string | null) {
    return {
      gateStatus: "awaiting_release",
      channels: ["coolify"],
      releaseRunnerLabel: null,
      baseBranch: "main",
      nextCutAt: null,
      issues: [
        {
          id: "iss-1",
          displayId: "ISS-1",
          title: "Ledger rows carry their tenant",
          mergedAt: null,
          waitingDays: null,
          claimedByRunId,
          closeRefusals: [],
          closeFailure: null,
        },
      ],
    };
  }

  it("reads the roster again, so the banner shows the release that holds the issue", async () => {
    roster.mockResolvedValueOnce(rosterWith(null)).mockResolvedValue(rosterWith("run-9"));
    create.mockImplementationOnce(() => Promise.reject(new Error("already claimed by a release")));
    const { result } = renderHook(
      () => ({ roster: useReleaseRoster("proj-1"), batch: useBatchRelease("proj-1") }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.roster.data?.issues[0]?.claimedByRunId).toBeNull());

    act(() => result.current.batch.mutate({ issueIds: ["iss-1"] }));

    await waitFor(() => expect(result.current.batch.isError).toBe(true));
    await waitFor(() =>
      expect(result.current.roster.data?.issues[0]?.claimedByRunId).toBe("run-9"),
    );
  });

  // The issues list and the roster are two reads of the same claim: a list left from before the
  // refusal still shows the issue as ready beside a banner that says a release holds it.
  it("reads the issues list again, so its rows no longer show the issue as ready", async () => {
    roster.mockResolvedValue(rosterWith("run-9"));
    search.mockResolvedValueOnce({ items: [{ id: "iss-1", claimedByRunId: null }] });
    search.mockResolvedValue({ items: [{ id: "iss-1", claimedByRunId: "run-9" }] });
    create.mockImplementationOnce(() => Promise.reject(new Error("already claimed by a release")));
    const { result } = renderHook(
      () => ({ list: useIssues("proj-1", {} as never), batch: useBatchRelease("proj-1") }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.list.data).toBeDefined());
    expect(search).toHaveBeenCalledTimes(1);

    act(() => result.current.batch.mutate({ issueIds: ["iss-1"] }));

    await waitFor(() => expect(result.current.batch.isError).toBe(true));
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  });
});
