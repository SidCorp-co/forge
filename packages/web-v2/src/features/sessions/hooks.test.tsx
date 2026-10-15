// @vitest-environment jsdom
//
// The sessions list re-reads itself while it shows a running session, on the period the Pipeline
// page polls: a heartbeat moves no event, so a list read once reads every running session as Quiet
// a minute later.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessions } from "./hooks";
import type { SessionRow } from "./types";

const list = vi.fn<() => Promise<{ items: SessionRow[]; totalCount: number }>>();
vi.mock("./api", () => ({ sessionsApi: { list: () => list() } }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const row = (status: SessionRow["status"]): SessionRow => ({
  id: "s1",
  projectId: "p1",
  userId: null,
  deviceId: "d1",
  pipelineRunId: "r1",
  title: "run: ISS-3",
  repoPath: null,
  status,
  kind: "run_session",
  usage: null,
  metadata: { type: "run_session" },
  failureReason: null,
  dispatchedAt: null,
  startedAt: "2026-10-15T09:30:00.000Z",
  lastHeartbeatAt: "2026-10-15T09:59:40.000Z",
  createdAt: "2026-10-15T09:30:00.000Z",
  updatedAt: "2026-10-15T09:59:40.000Z",
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

async function wait(ms: number) {
  for (let t = 0; t < ms; t += 5_000) {
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "setInterval"] });
  list.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the sessions list", () => {
  it("re-reads itself within twenty seconds while it shows a running session", async () => {
    list.mockResolvedValue({ items: [row("running")], totalCount: 1 });
    renderHook(() => useSessions({ projectId: "p1" }), { wrapper });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await wait(25_000);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("asks once and waits for an event where nothing it shows is running", async () => {
    list.mockResolvedValue({ items: [row("completed")], totalCount: 1 });
    renderHook(() => useSessions({ projectId: "p1" }), { wrapper });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await wait(45_000);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
