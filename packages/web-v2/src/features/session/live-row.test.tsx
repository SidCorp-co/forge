// @vitest-environment jsdom
//
// The session page judges a running session's silence on the check-in the Pipeline page reads, not
// on the row it fetched when it opened: a heartbeat moves no event, so a row read once and judged
// against a moving clock reads Stalled for a session the Pipeline page shows checking in.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSession, SessionsAndHolds } from "@/features/pipeline/types";
import { deriveSessionDisplayStatus, type SessionRow } from "@/features/sessions/types";
import { useLiveSessionRow } from "./live-row";

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
let clock = T0;
const reads = vi.fn<(projectId: string) => Promise<SessionsAndHolds>>();
vi.mock("@/features/pipeline/api", () => ({
  pipelineApi: { sessionsAndHolds: (projectId: string) => reads(projectId) },
}));

const row: SessionRow = {
  id: "s1",
  projectId: "p1",
  userId: null,
  deviceId: "d1",
  pipelineRunId: "r1",
  title: "run: ISS-3",
  repoPath: null,
  status: "running",
  kind: "run_session",
  usage: null,
  metadata: { type: "run_session" },
  failureReason: null,
  dispatchedAt: null,
  startedAt: new Date(T0 - 30 * 60_000).toISOString(),
  lastHeartbeatAt: new Date(T0 - 20_000).toISOString(),
  createdAt: new Date(T0 - 30 * 60_000).toISOString(),
  updatedAt: new Date(T0 - 20_000).toISOString(),
};

/** What the box keeps doing while the page is open: checking in, ten seconds before each read. */
function beatingNow(): SessionsAndHolds {
  const live: LiveSession = {
    id: "s1",
    kind: "run_session",
    title: "run: ISS-3",
    status: "running",
    runtimeState: "working",
    deviceId: "d1",
    deviceName: "box-a",
    parentSessionId: null,
    startedAt: row.startedAt,
    lastHeartbeatAt: new Date(clock - 10_000).toISOString(),
    createdAt: row.createdAt,
    issues: [],
    report: null,
  };
  return { sessions: [live], holds: [], readAt: new Date(clock).toISOString() };
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "setInterval", "Date"] });
  vi.setSystemTime(T0);
  clock = T0;
  reads.mockReset();
  reads.mockImplementation(async () => beatingNow());
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the session page's reading of a running session", () => {
  it("reads Running seventy-five seconds after it opened, while the box keeps checking in", async () => {
    const { result } = renderHook(() => useLiveSessionRow(row), { wrapper });
    for (let s = 0; s < 75; s += 5) {
      clock += 5_000;
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
    }
    await waitFor(() => expect(deriveSessionDisplayStatus(result.current as SessionRow, clock)).toBe("running"));
  });

  it("reads Stalled once the box stops checking in, on the same one-minute line as the Pipeline page", async () => {
    reads.mockImplementation(async () => ({ ...beatingNow(), sessions: [{ ...beatingNow().sessions[0], lastHeartbeatAt: row.lastHeartbeatAt }] }));
    const { result } = renderHook(() => useLiveSessionRow(row), { wrapper });
    await act(async () => {});
    clock += 75_000;
    vi.setSystemTime(clock);
    expect(deriveSessionDisplayStatus(result.current as SessionRow, clock)).toBe("stalled");
  });

  it("asks nothing for a session that is not running", () => {
    renderHook(() => useLiveSessionRow({ ...row, status: "completed" }), { wrapper });
    expect(reads).not.toHaveBeenCalled();
  });
});
