// @vitest-environment jsdom
//
// ISS-1154 — the dashboard calls the analytics hooks before its project's slug has resolved. A
// caller that is still waiting says so with `enabled: false`, and no request goes out for it: an
// unscoped one would be the cross-project read, which is not what a project's tile may fetch.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runsApi } from "./api";
import { useStepDurations, useThroughput } from "./hooks";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    runsApi: { ...actual.runsApi, stepDurations: vi.fn(async () => []), throughput: vi.fn(async () => []) },
  };
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

beforeEach(() => vi.clearAllMocks());

describe.each([
  ["useStepDurations", useStepDurations, () => runsApi.stepDurations],
  ["useThroughput", useThroughput, () => runsApi.throughput],
] as const)("%s", (_name, hook, api) => {
  it("sends no request while its caller says it is waiting", async () => {
    const { result } = renderHook(() => hook({ days: 7, projectId: undefined }, false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(api()).not.toHaveBeenCalled();
    expect(result.current.fetchStatus).toBe("idle");
  });

  it("reads once enabled, with the project it was given", async () => {
    renderHook(() => hook({ days: 7, projectId: "p1" }, true), { wrapper });
    await waitFor(() => expect(api()).toHaveBeenCalledWith({ days: 7, projectId: "p1" }));
  });

  it("reads by default, as the cross-project callers do", async () => {
    renderHook(() => hook({ days: 30 }), { wrapper });
    await waitFor(() => expect(api()).toHaveBeenCalledWith({ days: 30 }));
  });
});
