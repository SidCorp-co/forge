// useCodeTrace reads Forge's own requirement trace for a project once: the trace is a property of
// the build, so a second reader on the same project is served from the cache, not a second request.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { fakeCore } from "@/test/render";
import { useCodeTrace } from "./hooks";

const trace = {
  units: [
    { scope: "core", unit: "issues", serves: ["REQ-1"] },
    { scope: "core", unit: "retention", serves: [] },
  ],
  total: 2,
  untraced: 1,
};

function client() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={c}>{children}</QueryClientProvider>;
}

describe("useCodeTrace", () => {
  it("answers the project's code trace as core serves it", async () => {
    const calls = fakeCore(() => ({ body: trace }));
    const { result } = renderHook(() => useCodeTrace("p1"), { wrapper: client() });
    await waitFor(() => expect(result.current.data).toEqual(trace));
    expect(calls.map((c) => c.path)).toEqual(["/projects/p1/code-trace"]);
  });

  it("serves a second reader of the same project from the cache", async () => {
    const calls = fakeCore(() => ({ body: trace }));
    const wrapper = client();
    const first = renderHook(() => useCodeTrace("p1"), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    const second = renderHook(() => useCodeTrace("p1"), { wrapper });
    expect(second.result.current.data).toEqual(trace);
    expect(calls).toHaveLength(1);
  });

  it("reads another project's trace on its own", async () => {
    const calls = fakeCore((c) => ({ body: c.path.includes("p2") ? { units: [], total: 0, untraced: 0 } : trace }));
    const wrapper = client();
    const one = renderHook(() => useCodeTrace("p1"), { wrapper });
    const two = renderHook(() => useCodeTrace("p2"), { wrapper });
    await waitFor(() => expect(two.result.current.data?.total).toBe(0));
    await waitFor(() => expect(one.result.current.data?.total).toBe(2));
    expect(calls.map((c) => c.path).sort()).toEqual(["/projects/p1/code-trace", "/projects/p2/code-trace"]);
  });
});
