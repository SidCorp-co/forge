// @vitest-environment jsdom
//
// ISS-653 — the one coupling nothing type-checks: `routeEvent` invalidates by
// key PREFIX, so an operator query keyed anywhere else keeps serving stale
// numbers and says nothing. This test holds the two sides together by driving
// the real hooks and the real router, never a hand-written copy of either key.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeEvent } from "@/lib/ws/event-router";
import {
  useOperatorAdoption,
  useOperatorAlerts,
  useOperatorLiveRooms,
  useOperatorOverview,
  useOperatorWorkspaces,
} from "./hooks";

const { subscribe, unsubscribe } = vi.hoisted(() => ({
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@/lib/ws/client", () => ({ wsClient: { subscribe, unsubscribe } }));

vi.mock("./api", () => ({
  operatorApi: {
    overview: async () => ({ counts: {}, kpis: {}, glance: {} }),
    alerts: async () => ({ items: [], totalCount: 0 }),
    adoption: async () => [],
    workspaces: async () => ({ items: [], totalCount: 0 }),
  },
}));

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function wrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

async function mountOperatorQueries(qc: QueryClient) {
  const r = renderHook(
    () => ({
      overview: useOperatorOverview("24h"),
      alerts: useOperatorAlerts(),
      adoption: useOperatorAdoption(),
      workspaces: useOperatorWorkspaces("24h", "runs"),
    }),
    { wrapper: wrapper(qc) },
  );
  await waitFor(() => expect(r.result.current.overview.isSuccess).toBe(true));
  await waitFor(() => expect(r.result.current.workspaces.isSuccess).toBe(true));
  return r;
}

describe("the operator queries are reachable by the event router", () => {
  it("every key sits under the ['admin','ops'] prefix routeEvent invalidates", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mountOperatorQueries(qc);

    const keys = qc.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toHaveLength(4);
    for (const key of keys) {
      expect(key.slice(0, 2)).toEqual(["admin", "ops"]);
    }
  });

  it.each([
    ["pipeline_run.status_changed", { runId: "r1", status: "completed", projectId: "p1" }],
    ["job.cancelled", { jobId: "j1" }],
  ])("%s marks all four of them stale", async (event, data) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await mountOperatorQueries(qc);

    const fresh = qc.getQueryCache().getAll();
    expect(fresh.every((q) => q.state.isInvalidated)).toBe(false);

    routeEvent({ event, data, timestamp: new Date().toISOString() }, qc);

    const after = qc.getQueryCache().getAll();
    expect(after).toHaveLength(4);
    expect(after.every((q) => q.state.isInvalidated)).toBe(true);
  });
});

describe("useOperatorLiveRooms", () => {
  it("joins one room per project it is given", () => {
    renderHook(() => useOperatorLiveRooms(["p-2", "p-1"]), {
      wrapper: wrapper(new QueryClient()),
    });
    expect(subscribe.mock.calls.map(([r]) => r)).toEqual(["project:p-1", "project:p-2"]);
  });

  // cm:guard a refetch hands the hook a NEW array of the SAME ids every time — keying the effect on identity would unsubscribe and resubscribe all 34 rooms on every poll, and a room re-joined mid-flight drops the events in between
  it("does not churn its subscriptions when the same ids arrive in a new array", () => {
    const { rerender } = renderHook(({ ids }: { ids: string[] }) => useOperatorLiveRooms(ids), {
      wrapper: wrapper(new QueryClient()),
      initialProps: { ids: ["p-1", "p-2"] },
    });
    subscribe.mockClear();

    rerender({ ids: ["p-2", "p-1"] });

    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it("leaves every room when the screen unmounts", () => {
    const { unmount } = renderHook(() => useOperatorLiveRooms(["p-1", "p-2"]), {
      wrapper: wrapper(new QueryClient()),
    });
    unmount();
    expect(unsubscribe.mock.calls.map(([r]) => r)).toEqual(["project:p-1", "project:p-2"]);
  });
});
