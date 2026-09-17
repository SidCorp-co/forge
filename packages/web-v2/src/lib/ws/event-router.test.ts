import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { routeEvent } from "./event-router";
import { flushInvalidations } from "./invalidation-coalescer";

function capture() {
  const keys: string[] = [];
  const written = new Map<string, unknown>();
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey?: unknown[] }) => {
      keys.push(JSON.stringify(queryKey));
    },
    setQueryData: (queryKey: unknown[], value: unknown) => {
      const at = JSON.stringify(queryKey);
      written.set(at, typeof value === "function" ? (value as (p: unknown) => unknown)(written.get(at)) : value);
    },
    getQueryCache: () => ({
      findAll: () => [],
      subscribe: () => () => {},
      get: () => undefined,
    }),
  } as unknown as QueryClient;
  return {
    qc,
    keys,
    written,
    has: (k: unknown[]) => keys.includes(JSON.stringify(k)),
    wrote: (k: unknown[]) => written.get(JSON.stringify(k)),
  };
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

// cm:guard this is criterion 17, and it is the cost that chose this transport: a progress frame
// answered with an invalidation would refetch the whole conversation roughly eight times a second
// for the length of a turn. These cases assert the ABSENCE of an invalidation as well as the
// presence of the write, because a router that did both would pass on the write alone.
describe("a turn arriving on the socket while it is still being written", () => {
  const entry = { id: "entry-1", type: "assistant", content: "looking now" };

  it("writes the live turn into the room's own slot", () => {
    const c = send("conversation.progress", { conversationId: "c1", entry });
    expect(c.wrote(["conversation-progress", "c1"])).toMatchObject({
      conversationId: "c1",
      entry,
    });
  });

  it("does not refetch the conversation for a progress frame", () => {
    const c = send("conversation.progress", { conversationId: "c1", entry });
    expect(c.has(["conversations", "c1"])).toBe(false);
    expect(c.has(["conversations", "list"])).toBe(false);
    expect(c.keys).toHaveLength(0);
  });

  // cm:guard the marker survives the hop: it is what the thread draws the correction from, and a
  // router that wrote the entry and dropped the flag would substitute the replacement silently —
  // the one thing the amnesty behind this channel is not allowed to do.
  it("carries the replaced marker through to the slot", () => {
    const c = send("conversation.progress", { conversationId: "c1", entry, replaced: true });
    expect(c.wrote(["conversation-progress", "c1"])).toMatchObject({ replaced: true });
  });

  // cm:guard the settle MARKS the live turn and does not delete it, and the delivery touches it at
  // all: settlement says the server is done, not that this browser has the row, so a delete here
  // leaves the thread holding neither the streamed answer nor the durable one until the refetch
  // lands — and for a replaced reply it takes the withdrawal notice with it (consult F5).
  it("marks the live turn settled rather than deleting it, and leaves it alone on a delivery", () => {
    const c = capture();
    routeEvent(
      { event: "conversation.progress", data: { conversationId: "c1", entry }, timestamp: "t" },
      c.qc,
    );
    routeEvent({ event: "conversation.settled", data: { conversationId: "c1" }, timestamp: "t" }, c.qc);
    flushInvalidations();
    const live = c.wrote(["conversation-progress", "c1"]) as { entry: unknown; settled: boolean };
    expect(live.settled).toBe(true);
    expect(live.entry).toEqual(entry);

    expect(
      send("conversation.message", { conversationId: "c1" }).written.has('["conversation-progress","c1"]'),
    ).toBe(false);
  });

  // cm:guard the withdrawal is remembered against the ENTRY ID, so it outlives the live turn: the
  // durable row carries the replacement's text and says nothing about it having replaced anything,
  // and a notice that died with the streamed copy would be a correction a person had a second or
  // two to catch — the silent substitution arriving late rather than never (consult F5).
  it("remembers a replacement against its entry id", () => {
    const c = send("conversation.progress", { conversationId: "c1", entry, replaced: true });
    expect(c.wrote(["conversation-corrections", "c1"])).toEqual(["entry-1"]);
  });

  it("remembers an ordinary turn as no correction at all", () => {
    const c = send("conversation.progress", { conversationId: "c1", entry });
    expect(c.wrote(["conversation-corrections", "c1"])).toBeUndefined();
  });

  // cm:guard criterion 2's router half: acceptance is written, not invalidated, because the frame
  // already carries the durable id and this tab's own token — there is nothing left to go and ask
  // for, and asking would cost a read of the whole room at the worst possible moment.
  it("records an acceptance without refetching the room", () => {
    const c = send("conversation.accepted", {
      conversationId: "c1",
      messageId: "m9",
      seq: 3,
      clientToken: "outbox-1",
    });
    expect(c.wrote(["conversation-accepted", "c1"])).toEqual([
      { clientToken: "outbox-1", messageId: "m9" },
    ]);
    expect(c.keys).toHaveLength(0);
  });

  // cm:guard the two events that predate this change keep answering with an invalidation, so an
  // older tab and a room whose socket missed the frames both still end up correct.
  it("leaves conversation.message and conversation.settled invalidating as they did", () => {
    for (const event of ["conversation.message", "conversation.settled"]) {
      const c = send(event, { conversationId: "c1" });
      expect(c.has(["conversations", "c1"])).toBe(true);
      expect(c.has(["conversations", "list"])).toBe(true);
    }
  });

  // cm:guard react-query invalidates by PREFIX, so a slot spelled `['conversations', id, …]` is
  // refetched to its empty value by the delivery event above — the live turn would vanish on the
  // delivery rather than on the settle, and every held outbox row would go back to "Sending…" after
  // the server had already filed it. Both keys therefore sit outside that prefix, and this case is
  // what goes red if either is moved back under it.
  it("keys the two written slots outside every invalidated prefix", () => {
    const c = send("conversation.progress", { conversationId: "c1", entry });
    const accepted = send("conversation.accepted", {
      conversationId: "c1",
      messageId: "m9",
      clientToken: "o1",
    });
    for (const written of [...c.written.keys(), ...accepted.written.keys()]) {
      expect(JSON.parse(written)[0]).not.toBe("conversations");
    }
  });
});
