// useStuckRuns reads which runs core says are stuck (`runs/standing`, live scope) as one lookup a
// session row is checked against, by run id and by the run's session id; nothing reads stuck before
// core has answered.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { fakeCore } from "@/test/render";
import { useStuckRuns } from "./hooks";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const standing = {
  items: [
    { id: "run-1", sessionId: "sess-1", state: "stuck" },
    { id: "run-2", sessionId: null, state: "stuck" },
    { id: "run-3", sessionId: "sess-3", state: "running" },
  ],
};

describe("useStuckRuns", () => {
  it("reads the live scope of the project's run standing", async () => {
    const calls = fakeCore(() => ({ body: standing }));
    const { result } = renderHook(() => useStuckRuns("p1"), { wrapper });
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0));
    expect(calls[0]?.path).toMatch(/^\/projects\/p1\/runs\/standing\?scope=live&limit=\d+$/);
  });

  it("holds every stuck run by its id and its session's, and no run that is not stuck", async () => {
    fakeCore(() => ({ body: standing }));
    const { result } = renderHook(() => useStuckRuns("p1"), { wrapper });
    await waitFor(() => expect(result.current.size).toBeGreaterThan(0));
    expect([...result.current].sort()).toEqual(["run-1", "run-2", "sess-1"]);
  });

  it("is empty until core answers, and asks nothing without a project", async () => {
    const calls = fakeCore(() => ({ body: standing }));
    const { result } = renderHook(() => useStuckRuns(undefined), { wrapper });
    expect(result.current.size).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });
});
