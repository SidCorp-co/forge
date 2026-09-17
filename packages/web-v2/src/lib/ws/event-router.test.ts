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

// cm:guard `routeEvent` no longer invalidates synchronously — every key it decides on goes into a 250 ms window (ISS-1019) — so a case asserting without flushing reads an empty list and passes against a router that decided nothing at all.
const send = (event: string, data: Record<string, unknown> = {}) => {
  const c = capture();
  routeEvent({ event, data, timestamp: "2026-09-12T12:00:00.000Z" }, c.qc);
  flushInvalidations();
  return c;
};

afterEach(() => {
  flushInvalidations();
});

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

// cm:guard the issues list renders its dependency badges from the search response since ISS-1017, so `['issue', id, 'dependencies']` no longer reaches it — these cases are the only thing that goes red if the list prefix is dropped from that branch and the chips start outliving the edge that was retracted.
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

// cm:guard the prefix list is now ONE array read by both replays, so this is what says a prefix cannot be dropped from the reconnect path while it stays in the first-open one — the two used to be the same function and drift here is silent.
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

// cm:guard ISS-1078 criterion 17, and the frames' own ordering. This file's head rule is that every
// key it decides on sits under an invalidated prefix; the progress key is the one exception, written
// and never invalidated, because a frame arrives many times a second and carries the whole entry — so
// an invalidation per frame would refetch the entire conversation per token. These cases are what
// holds that exception to what it claims.
describe("a turn's progress frames are written, never fetched (ISS-1078)", () => {
  // cm:guard a cache double rather than `capture()` above, because the whole behaviour under test is
  // a WRITE: the mock up there has no `setQueryData` at all, and the router would throw before
  // deciding anything.
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
    // cm:guard asserted against the WHOLE list and not against one key: an invalidation of
    // `["conversations"]` or of the list would refetch this room just as surely as its own key.
    expect(c.keys).toEqual([]);
  });

  it("drops a frame that would rewind the text a reader is watching", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", rev: 7, entry: entry("two issues left") });
    c.frame("conversation.progress", { conversationId: "c1", rev: 3, entry: entry("two iss") });
    expect(c.at(["conversations", "c1", "progress"])).toMatchObject({ rev: 7 });
  });

  // cm:guard a new entry id is a NEW turn and its revisions start again from 1, so a guard that
  // compared revisions alone would silently drop the whole of the next turn.
  it("accepts a lower revision when it belongs to the next turn", () => {
    const c = cache();
    c.frame("conversation.progress", { conversationId: "c1", rev: 7, entry: entry("two issues left") });
    c.frame("conversation.progress", { conversationId: "c1", rev: 1, entry: entry("and one blocked", "m9") });
    expect(c.at(["conversations", "c1", "progress"])).toMatchObject({ rev: 1 });
  });

  // cm:guard the marker's lifetime is the reason this key exists: the correction frame and the settle
  // land within milliseconds of each other, and the settle clears the progress key — so a withdrawal
  // recorded only on the progress entry is on screen for about 13 ms. Measured in Chrome, 2026-09-17.
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

  // cm:guard keyed by the ENTRY the replacement belongs to, so a room that corrects twice marks each
  // turn with its own draft rather than the newest one above all of them.
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

// cm:guard ISS-1078 criteria 1 and 2 — the frame that tells one tab its own message is now a row.
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

  // cm:guard two tabs, each holding its own outbox row: a map keyed by anything but the token would
  // have one tab clear its row on the other's acceptance and drop somebody else's message off screen.
  it("keeps one tab's acceptance from answering another's", () => {
    const c = cache();
    c.frame({ conversationId: "c1", messageId: "m0", seq: 0, clientToken: "tok-a" });
    c.frame({ conversationId: "c1", messageId: "m1", seq: 1, clientToken: "tok-b" });
    expect(c.at(["conversations", "c1", "accepted"])).toEqual({
      "tok-a": { messageId: "m0", seq: 0 },
      "tok-b": { messageId: "m1", seq: 1 },
    });
  });

  // cm:guard somebody ELSE's message arriving is still news to this room, and it belongs to no outbox
  // row here — so the room is refreshed and no token is written.
  it("refreshes the room for a message this tab did not send", () => {
    const c = cache();
    c.frame({ conversationId: "c1", messageId: "m0", seq: 0 });
    expect(c.at(["conversations", "c1", "accepted"])).toBeUndefined();
    expect(c.invalidated(["conversations", "c1"])).toBe(true);
  });
});
