import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { routeEvent } from "./event-router";

function capture() {
  const keys: string[] = [];
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => {
      keys.push(JSON.stringify(queryKey));
    },
  } as unknown as QueryClient;
  return { qc, keys, has: (k: unknown[]) => keys.includes(JSON.stringify(k)) };
}

const send = (event: string, data: Record<string, unknown> = {}) => {
  const c = capture();
  routeEvent({ event, data, timestamp: "2026-09-12T12:00:00.000Z" }, c.qc);
  return c;
};

// cm:guard the dashboard is keyed `['pulse']`, and this file's own guard says a key outside the invalidated prefixes stops refreshing with nothing red to say so — these cases ARE that red. Each event below moves a figure the surface draws, so dropping one leaves the dashboard confidently stale (ISS-988).
describe("the workspace pulse is refreshed by every event that moves one of its figures", () => {
  const movers: Array<[string, Record<string, unknown>, string]> = [
    ["issue.created", {}, "the open bucket and the weekly created series"],
    ["issue.statusChanged", { issueId: "i1" }, "every work bucket and the flow"],
    ["job.completed", { jobId: "j1" }, "jobs running, queued and held"],
    ["job.failed", { jobId: "j1" }, "the live-job count and the failure lanes"],
    ["pipeline_run.status_changed", { runId: "r1" }, "runs claimed but empty"],
    ["device.statusChanged", {}, "the runner counts"],
    ["agent-session.status", { sessionId: "s1" }, "the session-failure reasons"],
  ];

  for (const [event, data, why] of movers) {
    it(`${event} — ${why}`, () => {
      expect(send(event, data).has(["pulse"])).toBe(true);
    });
  }

  // cm:guard a reconnect drops every event in the gap, so the replay is the only thing that repairs a dashboard left open across one (ISS-988)
  it("a reconnect replay refreshes it too", async () => {
    const c = capture();
    const { replayOnReconnect } = await import("./event-router");
    replayOnReconnect(c.qc);
    expect(c.has(["pulse"])).toBe(true);
  });

  it("an event that moves no figure on the surface does not refresh it", () => {
    expect(send("user.preferencesChanged").has(["pulse"])).toBe(false);
  });
});

describe("routeEvent", () => {
  it("ignores an event it does not know rather than throwing", () => {
    expect(() => send("nothing.likeThis")).not.toThrow();
  });
});
