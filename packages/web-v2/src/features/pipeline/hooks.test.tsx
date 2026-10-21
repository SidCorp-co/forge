// @vitest-environment jsdom
//
// ISS-1228 round 25 (the master's read of judge-81's run): once Forge refused the holds read with a
// 403 or a 404, every open page read it again on the 20 s poll and on each session check-in, about
// every 5 s with a box checking in, for ever, to be refused the same way each time. A refusal no
// retry changes is now read again only on Retry, on focus and on a frame naming a status change.

import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { flushInvalidations } from "@/lib/ws/invalidation-coalescer";
import { routeEvent } from "@/lib/ws/event-router";
import { createQueryClient } from "@/providers/query-provider";
import { pipelineApi } from "./api";
import { useSessionsAndHolds } from "./hooks";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, pipelineApi: { ...actual.pipelineApi, sessionsAndHolds: vi.fn() } };
});

const read = vi.mocked(pipelineApi.sessionsAndHolds);

let session = 0;

/** Mounts the read on a tab that has already heard its session running, so a check-in moves nothing. */
function mount() {
  const qc = createQueryClient();
  const sessionId = `s${++session}`;
  checkIn(qc, sessionId, "running");
  flushInvalidations();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useSessionsAndHolds("p1"), { wrapper });
  return { hook, frame: (status: string) => checkIn(qc, sessionId, status) };
}

function checkIn(qc: ReturnType<typeof createQueryClient>, sessionId: string, status: string) {
  routeEvent({ event: "agent-session.updated", data: { sessionId, status }, timestamp: "2026-10-21T09:00:00Z" }, qc);
}

beforeEach(() => {
  vi.useFakeTimers();
  read.mockReset();
});

afterEach(() => {
  cleanup();
  flushInvalidations();
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

describe("a read Forge refused for good (criteria 249 and 250)", () => {
  it.each([
    [403, "Not a project member.", "FORBIDDEN"],
    [404, "Project not found.", "NOT_FOUND"],
  ] as const)("is asked once in a minute of polls and check-ins after a %i", async (status, message, code) => {
    read.mockRejectedValue(new ApiError(status, message, code));
    const { hook, frame } = mount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hook.result.current.isError).toBe(true);

    for (let s = 0; s < 60; s += 5) {
      frame("running");
      await act(() => vi.advanceTimersByTimeAsync(5_000));
    }
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("is asked again on focus, on a status change and on Retry", async () => {
    read.mockRejectedValue(new ApiError(403, "Not a project member.", "FORBIDDEN"));
    const { hook, frame } = mount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    frame("running");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(2);

    // The holds read starts no sooner than two seconds after the focus read started (ISS-1228 r26).
    frame("failed");
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(read).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1_200));
    expect(read).toHaveBeenCalledTimes(3);

    await act(async () => {
      void hook.result.current.refetch();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("keeps polling a failure a retry can change", async () => {
    read.mockRejectedValue(new ApiError(503, "Forge is restarting.", "UNAVAILABLE"));
    mount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    // Three tries for the first read, then the poll every 20 s goes on.
    expect(read.mock.calls.length).toBeGreaterThan(3);
  });

  it("goes on polling a read that answers", async () => {
    read.mockResolvedValue({ sessions: [], holds: [] } as never);
    mount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(read).toHaveBeenCalledTimes(4);
  });
});

// ISS-1228 r27 (judge-85, criterion 259): with the holds read failing, reads started 21–260 ms apart,
// about 15 per 16 s: the read's own retries (1 s, then 2 s) ran beside the frame windows' 2.1 s gap,
// which counted only a read's first attempt. Retries now count inside the same budget.
describe("a holds read that fails under a storm of check-ins (criterion 259)", () => {
  const unavailable = new ApiError(503, "Forge is busy.", "UNAVAILABLE");

  async function storm(answerAfterMs: number) {
    const starts: number[] = [];
    let inFlight = 0;
    let mostInFlight = 0;
    read.mockImplementation(() => {
      starts.push(Date.now());
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      return new Promise((_, reject) =>
        setTimeout(() => {
          inFlight--;
          reject(unavailable);
        }, answerAfterMs),
      );
    });
    const { frame } = mount();
    // Sixteen seconds of check-ins, one every 100 ms, as seven sessions checking in every 5 s send.
    for (let ms = 0; ms < 16_000; ms += 100) {
      frame("running");
      await act(() => vi.advanceTimersByTimeAsync(100));
    }
    const gaps = starts.slice(1).map((at, i) => at - (starts[i] as number));
    return { starts, gaps, mostInFlight };
  }

  it.each([
    ["at once", 0],
    ["after 1.5 s", 1_500],
  ])("starts no read within two seconds of the last, its own retries included, when it fails %s", async (_name, ms) => {
    const { starts, gaps, mostInFlight } = await storm(ms);
    expect(starts.length).toBeGreaterThan(1);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_000);
    expect(starts.length).toBeLessThanOrEqual(8);
    expect(mostInFlight).toBe(1);
  });
});
