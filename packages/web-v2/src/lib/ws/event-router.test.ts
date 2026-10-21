import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { routeEvent } from "./event-router";
import { flushInvalidations } from "./invalidation-coalescer";

function capture() {
  const keys: string[] = [];
  const qc = {
    invalidateQueries: ({ queryKey }: { queryKey?: unknown[] }) => {
      keys.push(JSON.stringify(queryKey));
    },
    setQueriesData: () => [],
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

describe("a device event reaches the organization's list as well as the caller's own", () => {
	// ISS-1162 criterion 21. The Runners page reads two populations from two keys;
	// one refreshed and the other left stale is the same screen disagreeing with
	// itself that this change exists to remove.
	for (const event of [
		"device.login",
		"device.paired",
		"device.revoked",
		"device.statusChanged",
	]) {
		it(`${event} invalidates both device prefixes`, () => {
			const c = send(event);
			expect(c.has(["devices", "me"])).toBe(true);
			expect(c.has(["devices", "org"])).toBe(true);
		});
	}

	it("leaves both alone for an event about neither", () => {
		const c = send("user.preferencesChanged");
		expect(c.has(["devices", "me"])).toBe(false);
		expect(c.has(["devices", "org"])).toBe(false);
	});
});

// ISS-1228 round 15 repair: the box strip and the session rows each read a box's state on their own poll,
// so a box gone offline read Offline in one and Working in the other until both polled again.
describe("a box going offline or coming back reaches every surface that states its state", () => {
  it.each(["offline", "online"])("a box reported %s refreshes its project's runners and every session read", (status) => {
    const c = send("device.status", { deviceId: "d1", projectId: "p1", status });
    for (const key of [
      ["projects", "p1", "runners"],
      ["projects", "p1", "active-runners"],
      ["agent-sessions"],
      ["agent-session"],
      ["sessions-and-holds"],
      ["run-sessions"],
    ]) {
      expect(c.has(key), JSON.stringify(key)).toBe(true);
    }
  });

  it("refreshes nothing for a box state that names no project", () => {
    expect(send("device.status", { deviceId: "d1", status: "offline" }).keys).toEqual([]);
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
      ["run-journal"],
      ["pipeline-runs"],
      ["pipeline-run"],
      ["run-sessions"],
      ["sessions-and-holds"],
      ["jobs"],
      ["projects"],
      ["agent-sessions"],
      ["agent-session"],
      ["conversations"],
      ["attention"],
      ["pulse"],
      ["devices", "me"],
      ["devices", "org"],
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
    expect(c.keys).toHaveLength(22);
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

describe("the pipeline page's sessions and holds follow the events that move them (ISS-1228)", () => {
  it.each([
    ["agent-session.created", { sessionId: "s1" }],
    ["agent-session.status", { sessionId: "s1" }],
    ["agent-session.deleted", { sessionId: "s1" }],
    ["issue.statusChanged", { issueId: "i1" }],
    ["issue.updated", { issueId: "i1" }],
  ])("%s refreshes it", (event, data) => {
    expect(send(event, data).has(["sessions-and-holds"])).toBe(true);
  });

  it("a comment, which moves neither, does not", () => {
    expect(send("comment.created", { issueId: "i1" }).has(["sessions-and-holds"])).toBe(false);
  });
});

describe("the rail's live-session figure follows a session starting or ending (ISS-1228)", () => {
  it.each([
    ["agent-session.created", { sessionId: "s1" }],
    ["agent-session.status", { sessionId: "s1" }],
    ["agent-session.deleted", { sessionId: "s1" }],
  ])("%s refreshes the health rollup it reads", (event, data) => {
    expect(send(event, data).has(["projects", "health"])).toBe(true);
  });
});

describe("an open issue page's runs follow a stop made anywhere (ISS-1228 round 14)", () => {
  // Judge-36: an issue page left open while its session was stopped from the sessions list in
  // another tab read "Run 1 · Running" for 90 seconds; a session's events name no issue.
  it.each([
    ["agent-session.status", { sessionId: "s1", status: "failed", failureReason: "user_cancelled" }],
    ["agent-session.updated", { sessionId: "s1" }],
    ["pipeline_run.status_changed", { runId: "r1", status: "cancelled" }],
  ])("%s re-reads the run journal of every open issue page", async (event, data) => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { runJournalKey } = await import("@/features/issues/detail-hooks");
    const qc = new QueryClient();
    qc.setQueryData(runJournalKey("i3"), { runs: [] });
    routeEvent({ event, data, timestamp: "2026-10-18T12:00:00.000Z" }, qc);
    flushInvalidations();
    expect(qc.getQueryState(runJournalKey("i3"))?.isInvalidated).toBe(true);
  });

  it("an issue's own event re-reads that issue's runs and no other's", async () => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { runJournalKey } = await import("@/features/issues/detail-hooks");
    const qc = new QueryClient();
    qc.setQueryData(runJournalKey("i3"), { runs: [] });
    qc.setQueryData(runJournalKey("i4"), { runs: [] });
    routeEvent({ event: "issue.statusChanged", data: { issueId: "i3" }, timestamp: "2026-10-18T12:00:00.000Z" }, qc);
    flushInvalidations();
    expect(qc.getQueryState(runJournalKey("i3"))?.isInvalidated).toBe(true);
    expect(qc.getQueryState(runJournalKey("i4"))?.isInvalidated).toBe(false);
  });

  it("a reconnect repairs it", async () => {
    const c = capture();
    const { replayOnReconnect } = await import("./event-router");
    replayOnReconnect(c.qc);
    expect(c.has(["run-journal"])).toBe(true);
  });
});

describe("an open runs tab follows a stop made anywhere (ISS-1228 round 15)", () => {
  // Judge-39: the Agents runs tab open in another tab read a stopped run as Working, or waiting on a
  // person, for 3 to 13 seconds, until its 20-second poll; a stop never re-read its query.
  it.each([
    ["agent-session.status", { sessionId: "s1", status: "failed", failureReason: "user_cancelled" }],
    ["agent-session.updated", { sessionId: "s1" }],
    ["agent-session.created", { sessionId: "s2" }],
    ["pipeline_run.status_changed", { runId: "r1", status: "cancelled" }],
  ])("%s re-reads the runs tab of every open project", async (event, data) => {
    const { QueryClient } = await import("@tanstack/react-query");
    const { runSessionsKey } = await import("@/features/agents/hooks");
    const qc = new QueryClient();
    qc.setQueryData(runSessionsKey("p1"), { runs: [] });
    routeEvent({ event, data, timestamp: "2026-10-18T12:00:00.000Z" }, qc);
    flushInvalidations();
    expect(qc.getQueryState(runSessionsKey("p1"))?.isInvalidated).toBe(true);
  });

  it("a comment, which moves no run, does not", () => {
    expect(send("comment.created", { issueId: "i1" }).has(["run-sessions"])).toBe(false);
  });

  it("a reconnect repairs it, and the Pipeline page's read with it", async () => {
    const c = capture();
    const { replayOnReconnect } = await import("./event-router");
    replayOnReconnect(c.qc);
    expect(c.has(["run-sessions"])).toBe(true);
    expect(c.has(["sessions-and-holds"])).toBe(true);
  });
});

// ISS-1228 round 16 (judge-42): an open session page's rail counted "Busy · 3 live sessions" a second
// after a stop on another tab, then 2 on its next read. The stop's event takes the session out of the
// live read at once, as it arrives, before the re-read lands.
describe("a session's stop reaches the live read the box counts at once", () => {
  const read = () => ({
    sessions: [
      { id: "s1", deviceId: "d1" },
      { id: "s2", deviceId: "d1" },
    ],
    holds: [
      { issueId: "i1", holders: [{ by: "session", sessionId: "s1" }] },
      { issueId: "i2", holders: [{ by: "session", sessionId: "s1" }, { by: "person", status: "on_hold" }] },
    ],
    runningChats: [{ id: "c1", deviceId: "d1" }],
    readAt: "2026-10-18T15:00:00.000Z",
  });

  const afterEvent = (data: Record<string, unknown>) => {
    const qc = new QueryClient();
    qc.setQueryData(["sessions-and-holds", "p1"], read());
    routeEvent({ event: "agent-session.status", data, timestamp: "2026-10-18T15:00:01.000Z" }, qc);
    return qc.getQueryData(["sessions-and-holds", "p1"]) as ReturnType<typeof read>;
  };

  it("drops a stopped session, and the holds only it kept, before any re-read", () => {
    const out = afterEvent({ sessionId: "s1", status: "failed", failureReason: "user_cancelled" });
    expect(out.sessions.map((s) => s.id)).toEqual(["s2"]);
    expect(out.holds).toEqual([{ issueId: "i2", holders: [{ by: "person", status: "on_hold" }] }]);
  });

  it("drops a chat whose turn ended from the running chats, and keeps it no longer counted", () => {
    expect(afterEvent({ sessionId: "c1", status: "idle" }).runningChats).toEqual([]);
  });

  it("leaves the read as it was for a session still running", () => {
    expect(afterEvent({ sessionId: "s1", status: "running" })).toEqual(read());
  });
});

// ISS-1229 r16: a person retrying a failed job takes the failure off every open Needs you list.
describe("a failed job retried by a person", () => {
  it("refreshes the attention read and the job lists", () => {
    const c = send("job.retried", { jobId: "j2", retryOf: "j1" });
    expect(c.has(["attention"])).toBe(true);
    expect(c.has(["jobs", "list"])).toBe(true);
  });
});

// ISS-1228 round 17 (judge-45): every session check-in re-read every open tab's data — issue pages,
// the health rollup, the pulse — though a check-in that leaves the status alone moves none of them.
describe("a check-in re-reads only the session and the lists that show it", () => {
  const whole = [["run-journal"], ["projects", "health"], ["pulse"]];
  const shown = (id: string) => [["agent-session", id], ["agent-sessions"], ["sessions-and-holds"], ["run-sessions"]];

  it("leaves issue pages, the health rollup and the pulse alone where the status is the one last seen", () => {
    send("agent-session.status", { sessionId: "ci-1", status: "running" });
    const c = send("agent-session.updated", { sessionId: "ci-1", status: "running" });
    for (const k of shown("ci-1")) expect(c.has(k), JSON.stringify(k)).toBe(true);
    for (const k of whole) expect(c.has(k), JSON.stringify(k)).toBe(false);
  });

  it("re-reads the whole set where the status moved or was never seen", () => {
    send("agent-session.updated", { sessionId: "ci-2", status: "running" });
    const moved = send("agent-session.updated", { sessionId: "ci-2", status: "idle" });
    for (const k of whole) expect(moved.has(k), JSON.stringify(k)).toBe(true);
    const unseen = send("agent-session.updated", { sessionId: "ci-3", status: "running" });
    for (const k of whole) expect(unseen.has(k), JSON.stringify(k)).toBe(true);
  });

  it("re-reads the whole set for a status event, whatever was seen before", () => {
    send("agent-session.updated", { sessionId: "ci-4", status: "running" });
    const c = send("agent-session.status", { sessionId: "ci-4", status: "running" });
    for (const k of whole) expect(c.has(k), JSON.stringify(k)).toBe(true);
  });
});

// ISS-1228 round 19 (review F1): a run's word moves on a first check-in, a job event or a box flip, none of
// which said so to the run list, the open drawer or the issue page's Runs.
describe("every event that moves a run's word re-reads every read that says it", () => {
  const runReads = [["pipeline-runs", "list"], ["pipeline-run"], ["run-journal"]];

  it("re-reads the runs on a run session's first check-in, though its status is unchanged", () => {
    send("agent-session.status", { sessionId: "fc-1", status: "running" });
    const first = send("agent-session.updated", { sessionId: "fc-1", status: "running", started: true });
    for (const k of runReads) expect(first.has(k), JSON.stringify(k)).toBe(true);
    const later = send("agent-session.updated", { sessionId: "fc-1", status: "running" });
    for (const k of runReads) expect(later.has(k), JSON.stringify(k)).toBe(false);
  });

  it.each([
    ["job.assigned", { jobId: "j1" }],
    ["job.failed", { jobId: "j1" }],
    ["job.cancelled", { jobId: "j1" }],
    ["agent-session.status", { sessionId: "fc-2", status: "failed" }],
    ["device.status", { deviceId: "d1", projectId: "p1", status: "offline" }],
  ] as const)("re-reads the runs on %s", (event, data) => {
    const c = send(event, data);
    for (const k of runReads) expect(c.has(k), JSON.stringify(k)).toBe(true);
  });
});

// ISS-1228 round 22 (judge-71, criterion 227): an open issue page kept "Needs an answer" for a minute
// after its question was answered, because no event told a browser the answer had come.
describe("an answered question reaches every open page of its issue", () => {
  it("re-reads that issue's questions, park, issue and runs", () => {
    const c = send("question.answered", { questionId: "q1", projectId: "p1", issueId: "i3" });
    for (const key of [["questions", "i3"], ["issue", "i3"], ["comments", "i3"], ["run-journal"], ["pipeline-run"], ["questions", "project", "p1"]]) {
      expect(c.has(key), JSON.stringify(key)).toBe(true);
    }
  });

  it("marks the open issue page's run journal stale", async () => {
    const { runJournalKey } = await import("@/features/issues/detail-hooks");
    const qc = new QueryClient();
    qc.setQueryData(runJournalKey("i3"), { runs: [] });
    routeEvent({ event: "question.answered", data: { questionId: "q1", projectId: "p1", issueId: "i3" }, timestamp: "2026-10-21T12:00:00.000Z" }, qc);
    flushInvalidations();
    expect(qc.getQueryState(runJournalKey("i3"))?.isInvalidated).toBe(true);
  });
});
