import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { routeEvent } from "./event-router";
import { flushInvalidations } from "./invalidation-coalescer";

function capture() {
  const keys: string[] = [];
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey?: unknown[] }) => {
      keys.push(JSON.stringify(queryKey));
    },
    getQueryCache: () => ({
      findAll: () => [],
      subscribe: () => () => {},
      get: () => undefined,
    }),
  } as unknown as QueryClient;
  return { qc, keys, has: (k: unknown[]) => keys.includes(JSON.stringify(k)) };
}

const send = (event: string, data: Record<string, unknown> = {}) => {
  const c = capture();
  routeEvent({ event, data, timestamp: "2026-09-12T12:00:00.000Z" }, c.qc);
  flushInvalidations();
  return c;
};

afterEach(() => {
  flushInvalidations();
});

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

describe("a dependency change reaches the issues list, not only the two issues it names", () => {
  const c = send("dependencyChanged", {
    projectId: "p1",
    edgeId: "e1",
    fromIssueId: "i-from",
    toIssueId: "i-to",
    kind: "blocks",
  });

  it("invalidates the list the badges are rendered from", () => {
    expect(c.has(["issues", "search"])).toBe(true);
  });

  it("still invalidates each endpoint's own dependency key for the detail panel", () => {
    expect(c.has(["issue", "i-from", "dependencies"])).toBe(true);
    expect(c.has(["issue", "i-to", "dependencies"])).toBe(true);
  });
});

describe("a reconnect still repairs every prefix it repaired before", () => {
  it("invalidates every prefix a dropped connection has to repair", async () => {
    const c = capture();
    const { replayOnReconnect } = await import("./event-router");
    replayOnReconnect(c.qc);

    for (const key of [
      ["issues"],
      ["jobs"],
      ["projects"],
      ["agent-sessions"],
      ["agent-session"],
      ["conversations"],
      ["attention"],
      ["pulse"],
      ["devices", "me"],
      ["chat-logs"],
      ["integrations"],
      ["integration-connections"],
      ["questions"],
      ["notifications"],
      ["notifications-unread"],
      ["invitations-pending"],
    ]) {
      expect(c.has(key)).toBe(true);
    }
    expect(c.keys).toHaveLength(16);
  });
});
