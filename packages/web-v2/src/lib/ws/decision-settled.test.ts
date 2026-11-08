// A `decision.settled` frame for a feedback item reads its list, its items, Needs you and Attention
// again (ISS-1131, FB-568): before the router named it, a triage the master made left an open Feedback
// list, its peek and its grouping on "New · You triage it" until the page was opened afresh.

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeEvent } from "./event-router";
import { INVALIDATE_WINDOW_MS } from "./invalidation-coalescer";

const P = "p-1";
// the feedback feature's keys (`features/feedback/hooks.ts:feedbackKeys`), which lib may not import
const feedbackKeys = {
  list: (projectId: string) => ["feedback", projectId],
  item: (projectId: string, key: string) => ["feedback-item", projectId, key],
};
const frame = (act: string, projectId = P) => ({ event: "decision.settled", data: { projectId, act, subject: "FB-568" } }) as never;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function seeded() {
  const qc = new QueryClient();
  qc.setQueryData(feedbackKeys.list(P), {});
  qc.setQueryData(feedbackKeys.item(P, "FB-568"), {});
  qc.setQueryData(feedbackKeys.list("p-other"), {});
  qc.setQueryData(["needs-you", P], {});
  qc.setQueryData(["attention", null], {});
  return qc;
}

const stale = (qc: QueryClient, key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated;

describe("decision.settled", () => {
  it("reads the project's feedback list, its items, Needs you and Attention again after a triage", () => {
    const qc = seeded();
    routeEvent(frame("feedback.triaged"), qc);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS + 1);
    expect(stale(qc, feedbackKeys.list(P)), "the list kept the triage's old answer").toBe(true);
    expect(stale(qc, feedbackKeys.item(P, "FB-568"))).toBe(true);
    expect(stale(qc, ["needs-you", P])).toBe(true);
    expect(stale(qc, ["attention", null])).toBe(true);
    expect(stale(qc, feedbackKeys.list("p-other")), "another project's list is not this decision's").toBe(false);
  });

  it("leaves the feedback reads alone for a decision on something else", () => {
    const qc = seeded();
    routeEvent(frame("revision.accept"), qc);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS + 1);
    expect(stale(qc, feedbackKeys.list(P))).toBe(false);
    expect(stale(qc, ["needs-you", P])).toBe(true);
  });
});
