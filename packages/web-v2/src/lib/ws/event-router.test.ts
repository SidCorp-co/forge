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
      ["notifications-open"],
      ["invitations-pending"],
    ]) {
      expect(c.has(key)).toBe(true);
    }
    expect(c.keys).toHaveLength(16);
  });
});

describe("a turn's progress frames are written, never fetched (ISS-1078)", () => {
  function cache() {
    const keys: string[] = [];
    const store = new Map<string, unknown>();
    const qc = {
      invalidateQueries: ({ queryKey }: { queryKey?: unknown[] }) => {
        keys.push(JSON.stringify(queryKey));
      },
      setQueryData: (key: unknown[], next: unknown) => {
        const k = JSON.stringify(key);
        store.set(k, typeof next === "function" ? (next as (p: unknown) => unknown)(store.get(k)) : next);
      },
      getQueryCache: () => ({ findAll: () => [], subscribe: () => () => {}, get: () => undefined }),
    } as unknown as QueryClient;
    return {
      qc,
      at: (key: unknown[]) => store.get(JSON.stringify(key)),
      invalidated: (key: unknown[]) => keys.includes(JSON.stringify(key)),
      keys,
      frame: (event: string, data: Record<string, unknown>) => {
        routeEvent({ event, data, timestamp: "2026-09-17T12:00:00.000Z" }, qc);
        flushInvalidations();
      },
    };
  }

  const entry = (content: string, id = "m1") => ({ id, type: "assistant", timestamp: 1, content });

  it("puts the entry where the thread reads it and refetches nothing", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", rev: 1, entry: entry("two iss") });
    expect(c.at(["conversations", "c1", "progress"])).toMatchObject({ rev: 1 });
    expect(c.keys).toEqual([]);
  });

  it("drops a frame that would rewind the text a reader is watching", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", rev: 7, entry: entry("two issues left") });
    c.frame("conversation.progress", { conversationId: "c1", rev: 3, entry: entry("two iss") });
    expect(c.at(["conversations", "c1", "progress"])).toMatchObject({ rev: 7 });
  });

  it("accepts a lower revision when it belongs to the next turn", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", rev: 7, entry: entry("two issues left") });
    c.frame("conversation.progress", { conversationId: "c1", rev: 1, entry: entry("and one blocked", "m9") });
    expect(c.at(["conversations", "c1", "progress"])).toMatchObject({ rev: 1 });
  });

  it("records a withdrawn draft under a key the settle does not clear", () => {
    const c = cache();
    c.frame("conversation.progress", {
      conversationId: "c1",
      rev: 6,
      entry: entry("the sentence that went out"),
      replaced: { draft: "ISS-99999 is the blocker" },
    });
    c.frame("conversation.settled", { conversationId: "c1" });

    expect(c.at(["conversations", "c1", "progress"])).toBeNull();
    expect(c.at(["conversations", "c1", "withdrawn"])).toEqual({
      m1: "ISS-99999 is the blocker",
    });
  });

  it("keeps one withdrawal per turn", () => {
    const c = cache();
    c.frame("conversation.progress", {
      conversationId: "c1",
      rev: 2,
      entry: entry("first replacement"),
      replaced: { draft: "first draft" },
    });
    c.frame("conversation.progress", {
      conversationId: "c1",
      rev: 2,
      entry: entry("second replacement", "m9"),
      replaced: { draft: "second draft" },
    });
    expect(c.at(["conversations", "c1", "withdrawn"])).toEqual({
      m1: "first draft",
      m9: "second draft",
    });
  });

  it("records nothing for a frame that replaced nothing", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", rev: 1, entry: entry("streaming") });
    expect(c.at(["conversations", "c1", "withdrawn"])).toBeUndefined();
  });

  it("clears the in-flight entry when the turn settles, so it is not drawn beside its own row", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", rev: 2, entry: entry("two iss") });
    c.frame("conversation.settled", { conversationId: "c1" });
    expect(c.at(["conversations", "c1", "progress"])).toBeNull();
    expect(c.invalidated(["conversations", "c1"])).toBe(true);
  });

  it("leaves a frame with no revision alone rather than writing a rewind", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", entry: entry("two iss") });
    expect(c.at(["conversations", "c1", "progress"])).toBeUndefined();
  });
});

describe("an accepted message is filed under the token its tab minted (ISS-1078)", () => {
  function cache() {
    const store = new Map<string, unknown>();
    const keys: string[] = [];
    const qc = {
      invalidateQueries: ({ queryKey }: { queryKey?: unknown[] }) => keys.push(JSON.stringify(queryKey)),
      setQueryData: (key: unknown[], next: unknown) => {
        const k = JSON.stringify(key);
        store.set(k, typeof next === "function" ? (next as (p: unknown) => unknown)(store.get(k)) : next);
      },
      getQueryCache: () => ({ findAll: () => [], subscribe: () => () => {}, get: () => undefined }),
    } as unknown as QueryClient;
    return {
      qc,
      at: (key: unknown[]) => store.get(JSON.stringify(key)),
      invalidated: (key: unknown[]) => keys.includes(JSON.stringify(key)),
      frame: (data: Record<string, unknown>) => {
        routeEvent({ event: "conversation.accepted", data, timestamp: "2026-09-17T12:00:00.000Z" }, qc);
        flushInvalidations();
      },
    };
  }

  it("records which durable row the token became", () => {
    const c = cache();
    c.frame({ conversationId: "c1", messageId: "m0", seq: 0, clientToken: "tok-a" });
    expect(c.at(["conversations", "c1", "accepted"])).toEqual({ "tok-a": { messageId: "m0", seq: 0 } });
  });

  it("keeps one tab's acceptance from answering another's", () => {
    const c = cache();
    c.frame({ conversationId: "c1", messageId: "m0", seq: 0, clientToken: "tok-a" });
    c.frame({ conversationId: "c1", messageId: "m1", seq: 1, clientToken: "tok-b" });
    expect(c.at(["conversations", "c1", "accepted"])).toEqual({
      "tok-a": { messageId: "m0", seq: 0 },
      "tok-b": { messageId: "m1", seq: 1 },
    });
  });

  it("refreshes the room for a message this tab did not send", () => {
    const c = cache();
    c.frame({ conversationId: "c1", messageId: "m0", seq: 0 });
    expect(c.at(["conversations", "c1", "accepted"])).toBeUndefined();
    expect(c.invalidated(["conversations", "c1"])).toBe(true);
  });
});
