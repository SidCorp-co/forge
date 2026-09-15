// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { PROJECT_HEALTH_STALE_MS, useProjectHealth } from "./hooks";
import { projectApi } from "./api";

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const client = () =>
  new QueryClient({
    defaultOptions: { queries: { staleTime: 60_000, gcTime: 300_000, retry: false } },
  });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useProjectHealth's refetch cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  // cm:guard the rail mounts this query on EVERY workspace route, so what this asserts is what walking around the app costs — and it is the case that goes red if the staleTime is dropped back to the library default (ISS-1018).
  it("does not refetch on a second mount ninety seconds later, which the library default would", async () => {
    const qc = client();
    const health = vi.spyOn(projectApi, "health").mockResolvedValue([]);

    const first = renderHook(() => useProjectHealth(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(health).toHaveBeenCalledTimes(1));
    first.unmount();

    // cm:why ninety seconds sits BETWEEN the two windows — past the library's 60 s default, well inside the five minutes this hook sets — and a shorter gap would pass against either and prove nothing.
    vi.setSystemTime(Date.now() + 90_000);

    const second = renderHook(() => useProjectHealth(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(health).toHaveBeenCalledTimes(1);
  });

  // cm:guard the pair to the case above, and the reason the staleTime is not a freshness claim: invalidateQueries does not consult it, so every WebSocket event that moves one of these figures still reaches the screen at once. Delete this and that number reads as a five-minute staleness window, which it is not.
  it("refetches inside the window when the key is invalidated", async () => {
    const qc = client();
    const health = vi.spyOn(projectApi, "health").mockResolvedValue([]);

    const view = renderHook(() => useProjectHealth(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(health).toHaveBeenCalledTimes(1));

    qc.invalidateQueries({ queryKey: ["projects", "health"] });
    await waitFor(() => expect(health).toHaveBeenCalledTimes(2));
    view.unmount();
  });

  it("states the window in minutes, not in the library's default seconds", () => {
    expect(PROJECT_HEALTH_STALE_MS).toBeGreaterThanOrEqual(120_000);
    expect(PROJECT_HEALTH_STALE_MS).toBeLessThanOrEqual(300_000);
  });
});
