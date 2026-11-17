// A `box.changed` frame (ISS-1276) refreshes the project's Boxes and that box's feed and spans: with no
// route the frame falls to the router's "unhandled event" log, and a take, a hand-back or an agent's
// act shows only on the next reload.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeEvent } from "./event-router";
import { INVALIDATE_WINDOW_MS } from "./invalidation-coalescer";

const PROJECT = "p-1";
const BOX = "b-1";
const frame = { event: "box.changed", data: { boxId: BOX, projectId: PROJECT, issueId: null, state: "person", holder: "person:u", actSeq: 3, at: "2026-11-17T10:00:00.000Z" } } as never;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("box.changed", () => {
  it("invalidates the project's boxes and that box's feed and spans, and no other box's", () => {
    const qc = new QueryClient();
    for (const key of [["boxes", PROJECT], ["box", BOX, "acts"], ["box", BOX, "spans"], ["box", "b-2", "acts"]]) qc.setQueryData(key, []);
    routeEvent(frame, qc);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS + 1);
    expect(qc.getQueryState(["boxes", PROJECT])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["box", BOX, "acts"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["box", BOX, "spans"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["box", "b-2", "acts"])?.isInvalidated).toBe(false);
  });
});
