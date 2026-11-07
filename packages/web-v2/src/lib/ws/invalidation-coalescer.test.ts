// One key goes at most once per live gap (ISS-1070): on a busy project a frame lands every second,
// and every project-wide read on screen went again on each one. A frame inside the gap is never lost:
// the key fires once at the gap's end.
// @direct-test-of packages/web-v2/src/lib/ws/invalidation-coalescer.ts

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVALIDATE_WINDOW_MS, LIVE_MIN_GAP_MS, scheduleInvalidation } from "./invalidation-coalescer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function counted(qc: QueryClient, key: readonly unknown[]) {
  const spy = vi.spyOn(qc, "invalidateQueries");
  return () => spy.mock.calls.filter(([f]) => JSON.stringify(f?.queryKey) === JSON.stringify(key)).length;
}

describe("a key invalidated by frames a second apart", () => {
  it("fires at most once per gap, and once more after the last frame", async () => {
    const qc = new QueryClient();
    const key = ["issues", "standing"];
    const fires = counted(qc, key);
    const frames = 2 * (LIVE_MIN_GAP_MS / 1_000);
    for (let i = 0; i < frames; i++) {
      scheduleInvalidation(qc, key);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS);
    // the first at the window's end, then one per gap, the frames after the last fire carried by one more
    expect(fires()).toBe(3);
  });

  it("fires a key no frame touched for a gap at the window's end", async () => {
    const qc = new QueryClient();
    const key = ["preview", "a"];
    const fires = counted(qc, key);
    scheduleInvalidation(qc, key);
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS + 1);
    expect(fires()).toBe(1);
    await vi.advanceTimersByTimeAsync(LIVE_MIN_GAP_MS);
    scheduleInvalidation(qc, key);
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS + 1);
    expect(fires()).toBe(2);
  });

  it("holds one client's key for its own gap, never another client's", async () => {
    const one = new QueryClient();
    const other = new QueryClient();
    const key = ["attention"];
    const oneFires = counted(one, key);
    const otherFires = counted(other, key);
    scheduleInvalidation(one, key);
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS + 1);
    scheduleInvalidation(other, key);
    await vi.advanceTimersByTimeAsync(INVALIDATE_WINDOW_MS + 1);
    expect([oneFires(), otherFires()]).toEqual([1, 1]);
  });
});
