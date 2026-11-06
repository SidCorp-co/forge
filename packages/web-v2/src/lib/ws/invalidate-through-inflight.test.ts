// A frame never cancels a read in flight (ISS-1070): on a busy project the shell's slow reads were sent
// again on every frame and none answered. A read sent before the frames owes one more fetch once it
// settles, however many frames came while it flew.
// @direct-test-of packages/web-v2/src/lib/ws/invalidate-through-inflight.ts

import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateThroughInFlight } from "./invalidate-through-inflight";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A read core takes `ms` to answer, mounted the way a screen holds it, counting what it sent. */
function slowRead(qc: QueryClient, ms: number) {
  let sent = 0;
  let answered = 0;
  const ask = () => {
    sent += 1;
    return new Promise<number>((r) =>
      setTimeout(() => {
        answered += 1;
        r(sent);
      }, ms),
    );
  };
  const observer = new QueryObserver(qc, { queryKey: ["attention", "org"], queryFn: ask });
  const off = observer.subscribe(() => {});
  return { sent: () => sent, answered: () => answered, off };
}

async function settleFor(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("an invalidation over a read in flight", () => {
  it("lets the read answer and sends it once more, however many frames came while it flew", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const read = slowRead(qc, 5_000);
    await settleFor(5_001);
    expect([read.sent(), read.answered()]).toEqual([1, 1]);

    // the refetch a frame starts, then four more frames, one a second, while it flies
    invalidateThroughInFlight(qc, { queryKey: ["attention"] });
    for (let i = 0; i < 4; i++) {
      await settleFor(1_000);
      invalidateThroughInFlight(qc, { queryKey: ["attention"] });
    }
    await settleFor(12_000);

    expect(read.sent()).toBe(3);
    expect(read.answered()).toBe(3);
    expect(qc.getQueryData(["attention", "org"])).toBe(3);
    read.off();
  });

  it("sends a read no frame finds in flight once per invalidation", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
    const read = slowRead(qc, 100);
    await settleFor(101);
    invalidateThroughInFlight(qc, { queryKey: ["attention"] });
    await settleFor(101);
    invalidateThroughInFlight(qc, { queryKey: ["attention"] });
    await settleFor(101);
    expect([read.sent(), read.answered()]).toEqual([3, 3]);
    read.off();
  });
});
