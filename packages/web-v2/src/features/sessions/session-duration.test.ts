// @vitest-environment jsdom
//
// ISS-1228 r11 repair: one ended session read three durations — the turn line ran to the page's load,
// the rail and list to its last update. Every surface now reads this one hook.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionDuration } from "./session-duration";

const NOW = Date.parse("2026-10-16T08:00:00.000Z");
const startedAt = new Date(NOW - 41 * 60_000).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("useSessionDuration", () => {
  it("reads an ended session started to ended, and holds it as time passes", () => {
    const ended = { startedAt, updatedAt: new Date(NOW - 32_000).toISOString() };
    const { result, rerender } = renderHook(() => useSessionDuration(ended, false));
    expect(result.current).toBe("40m 28s");
    act(() => vi.advanceTimersByTime(5 * 60_000));
    rerender();
    expect(result.current).toBe("40m 28s");
  });

  it("ticks a live session from its start", () => {
    const live = { startedAt, updatedAt: new Date(NOW).toISOString() };
    const { result } = renderHook(() => useSessionDuration(live, true));
    expect(result.current).toBe("41m 00s");
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe("41m 05s");
  });

  it("reads a dash for a session that never started", () => {
    const { result } = renderHook(() =>
      useSessionDuration({ startedAt: null, updatedAt: new Date(NOW).toISOString() }, false),
    );
    expect(result.current).toBe("—");
  });
});
