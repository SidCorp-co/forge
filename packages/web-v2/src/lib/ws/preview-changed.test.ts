// A `preview.changed` frame refreshes the issue's preview read (REQ-39): before the route named it, the
// frame fell to the router's "unhandled event" log and the panel waited on its own clock.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INVALIDATE_WINDOW_MS } from "./invalidation-coalescer";
import { routeEvent } from "./event-router";

const ISSUE = "11111111-1111-4111-8111-111111111111";
const frame = (issueId: string) =>
  ({ event: "preview.changed", data: { previewId: "p", projectId: "q", issueId, state: "live", reason: null, at: "2026-10-09T10:00:00.000Z" } }) as never;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("preview.changed", () => {
  it("invalidates that issue's preview and its lane read, and no other issue's", () => {
    const qc = new QueryClient();
    qc.setQueryData(["preview", ISSUE], null);
    qc.setQueryData(["preview", ISSUE, "lane"], {});
    qc.setQueryData(["preview", "other"], null);
    routeEvent(frame(ISSUE), qc);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS + 1);
    expect(qc.getQueryState(["preview", ISSUE])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["preview", ISSUE, "lane"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["preview", "other"])?.isInvalidated).toBe(false);
  });
});
