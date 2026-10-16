import { describe, expect, it } from "vitest";
import {
  checkInOf,
  doingOf,
  holderLine,
  orderHolds,
  orderSessions,
  QUIET_AFTER_MS,
  readAtLine,
  sessionKindLabel,
  sessionName,
  waitingOnOf,
} from "./derive";
import type { HeldIssue, Holder, LiveSession } from "./types";

const NOW = Date.parse("2026-10-15T02:00:00.000Z");
const AT = Date.parse("2026-10-15T10:00:00.000Z");
const HEARD = new Date(AT - 5_000).toISOString();
const SILENT = new Date(AT - 90_000).toISOString();

const session = (over: Partial<LiveSession> = {}): LiveSession => ({
  id: "s1",
  kind: "run_session",
  title: "run: ISS-7",
  status: "running",
  runtimeState: "working",
  deviceId: "d1",
  deviceName: "box-a",
  parentSessionId: null,
  startedAt: "2026-10-15T01:00:00.000Z",
  lastHeartbeatAt: "2026-10-15T01:59:40.000Z",
  createdAt: "2026-10-15T01:00:00.000Z",
  issues: [],
  report: null,
  ...over,
});

describe("doingOf — what a session is doing, in words", () => {
  it.each([
    [{ status: "queued", runtimeState: null }, "Waiting for a box"],
    [{ status: "idle", runtimeState: null }, "Not started"],
    [{ status: "running", runtimeState: "starting" }, "Starting"],
    [{ status: "running", runtimeState: "working" }, "Working"],
    [{ status: "running", runtimeState: "awaiting_input" }, "Waiting for input"],
    [{ status: "running", runtimeState: "checkpointing" }, "Checkpointing"],
    [{ status: "running", runtimeState: "closed" }, "Closing"],
    [{ status: "running", runtimeState: null }, "Working"],
  ])("%o reads %s", (s, label) => {
    expect(doingOf({ ...s, lastHeartbeatAt: HEARD, startedAt: HEARD }, AT).label).toBe(label);
  });

  it("lets a queued status outrank a runtime state the box left behind", () => {
    expect(
      doingOf({ status: "queued", runtimeState: "working", lastHeartbeatAt: null, startedAt: null }, AT).label,
    ).toBe("Waiting for a box");
  });

  it("says what a running session silent past a minute last reported, never that it is doing it", () => {
    const silent = { status: "running", lastHeartbeatAt: SILENT, startedAt: SILENT };
    expect(doingOf({ ...silent, runtimeState: "working" }, AT)).toEqual({
      label: "Last reported working",
      tone: "neutral",
    });
    expect(doingOf({ ...silent, runtimeState: "awaiting_input" }, AT).label).toBe(
      "Last reported waiting for input",
    );
    expect(doingOf({ ...silent, runtimeState: null }, AT).label).toBe("Last reported working");
  });

  it("calls a session its box reports blocked Blocked, never Working, and a quiet one Last reported blocked", () => {
    const report = {
      incarnation: "live",
      work: "blocked",
      blockerKind: "human",
      waitingOn: "the owner's answer",
      observedAt: HEARD,
    };
    const heard = { status: "running", runtimeState: "working", startedAt: HEARD, report };
    expect(doingOf({ ...heard, lastHeartbeatAt: HEARD }, AT)).toEqual({ label: "Blocked", tone: "attention" });
    expect(doingOf({ ...heard, lastHeartbeatAt: SILENT }, AT)).toEqual({
      label: "Last reported blocked",
      tone: "neutral",
    });
    expect(doingOf({ ...heard, lastHeartbeatAt: HEARD, report: { ...report, work: "runnable" } }, AT).label).toBe(
      "Working",
    );
  });

  it("calls a session heard from exactly a minute ago working, and one a second past that quiet", () => {
    const at = (ms: number) => new Date(AT - ms).toISOString();
    const base = { status: "running", runtimeState: "working" };
    expect(doingOf({ ...base, lastHeartbeatAt: at(60_000), startedAt: null }, AT).label).toBe("Working");
    expect(doingOf({ ...base, lastHeartbeatAt: at(61_000), startedAt: null }, AT).label).toBe(
      "Last reported working",
    );
  });
});


describe("waitingOnOf — who can end the wait, in the box's words", () => {
  const report = (over: Partial<NonNullable<LiveSession["report"]>>) => ({
    incarnation: "live",
    work: "blocked",
    blockerKind: "human",
    waitingOn: "the answer on ISS-7",
    observedAt: "2026-10-15T01:59:00.000Z",
    ...over,
  });

  it("names the blocker and what it waits on", () => {
    expect(waitingOnOf({ report: report({}) })).toEqual({ text: "A person — the answer on ISS-7", blocked: true });
  });

  it("names the blocker alone where the box said nothing more", () => {
    expect(waitingOnOf({ report: report({ blockerKind: "machine", waitingOn: null }) }).text).toBe("A machine");
  });

  it("says Nothing only where the box reported the session runnable", () => {
    expect(waitingOnOf({ report: report({ work: "runnable" }) })).toEqual({ text: "Nothing", blocked: false });
  });

  it("says the box sent no report rather than reading its silence as unblocked", () => {
    expect(waitingOnOf({ report: null })).toEqual({ text: "Not reported by the box", blocked: false });
  });

  it("prints an unknown blocker kind as sent rather than guessing", () => {
    expect(waitingOnOf({ report: report({ blockerKind: "vendor", waitingOn: null }) }).text).toBe("vendor");
  });
});

describe("checkInOf — the last check-in, and quiet past the threshold", () => {
  it("reads a fresh beat plainly", () => {
    expect(checkInOf(session(), NOW)).toEqual({ text: "20s ago", quiet: false });
  });

  it("is not quiet at exactly the threshold, and is one millisecond past it", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(checkInOf(session({ lastHeartbeatAt: at(QUIET_AFTER_MS) }), NOW).quiet).toBe(false);
    expect(checkInOf(session({ lastHeartbeatAt: at(QUIET_AFTER_MS + 1) }), NOW).quiet).toBe(true);
  });

  it("marks a running session that never checked in as quiet once it has run past the threshold, and a queued one as not", () => {
    expect(checkInOf(session({ lastHeartbeatAt: null }), NOW)).toEqual({ text: "No check-in yet", quiet: true });
    expect(checkInOf(session({ status: "queued", lastHeartbeatAt: null }), NOW).quiet).toBe(false);
  });

  it("does not mark quiet a session that started inside the threshold and has not checked in yet", () => {
    const started = new Date(NOW - 10_000).toISOString();
    expect(checkInOf(session({ lastHeartbeatAt: null, startedAt: started }), NOW)).toEqual({
      text: "No check-in yet",
      quiet: false,
    });
  });
});

describe("orderSessions — masters first, with what they own beneath them", () => {
  it("nests a master's sessions under it and lists the rest after", () => {
    const master = session({ id: "m", kind: "master", createdAt: "2026-10-15T00:00:00.000Z" });
    const child = session({ id: "c", parentSessionId: "m", createdAt: "2026-10-15T01:00:00.000Z" });
    const loose = session({ id: "l", createdAt: "2026-10-14T00:00:00.000Z" });
    const out = orderSessions([child, loose, master]);
    expect(out.map((o) => [o.session.id, o.depth])).toEqual([
      ["m", 0],
      ["c", 1],
      ["l", 0],
    ]);
  });

  it("lists a session whose owner is not live at the top level rather than dropping it", () => {
    const orphan = session({ id: "o", parentSessionId: "gone" });
    expect(orderSessions([orphan]).map((o) => o.session.id)).toEqual(["o"]);
  });
});

describe("session names", () => {
  it("uses the title, else the kind, and names no run or stage for a session kind", () => {
    expect(sessionName({ kind: "master", title: null })).toBe("Master");
    expect(sessionName({ kind: "run_session", title: "  " })).toBe("Agent");
    expect(["master", "run_session", "pipeline", "pm"].map(sessionKindLabel).join(" ")).not.toMatch(
      /\b(run|stage|step|job)\b/i,
    );
  });
});

describe("holderLine — who holds an issue, why, and since when", () => {
  it("names a session with its box", () => {
    const h: Holder = {
      by: "session",
      sessionId: "s1",
      sessionTitle: "run: ISS-7",
      sessionKind: "run_session",
      deviceName: "box-a",
      since: "2026-10-15T01:00:00.000Z",
    };
    expect(holderLine(h, NOW, [session()])).toEqual({ who: "run: ISS-7 on box-a", why: "Working", since: "1h ago" });
  });

  it("says what a quiet session holding an issue last reported and how long ago, never that it is working it", () => {
    const h: Holder = {
      by: "session",
      sessionId: "s1",
      sessionTitle: "run: ISS-7",
      sessionKind: "run_session",
      deviceName: "box-a",
      since: "2026-10-15T01:00:00.000Z",
    };
    const quiet = session({ lastHeartbeatAt: "2026-10-15T01:58:00.000Z" });
    expect(holderLine(h, NOW, [quiet]).why).toBe("Last reported working · 2m ago");
    const waiting = session({ runtimeState: "awaiting_input" });
    expect(holderLine(h, NOW, [waiting]).why).toBe("Waiting for input");
  });

  it("claims nothing for a session holder whose session the read did not return", () => {
    const h: Holder = {
      by: "session",
      sessionId: "gone",
      sessionTitle: null,
      sessionKind: "run_session",
      deviceName: null,
      since: "2026-10-15T01:00:00.000Z",
    };
    expect(holderLine(h, NOW, [session()]).why).toBe("What its session is doing was not read");
    expect(holderLine(h, NOW).why).not.toMatch(/working/i);
  });

  it("names a claim with its holder and expiry, and calls its time a renewal", () => {
    const h: Holder = {
      by: "claim",
      holder: "iss-8-abc",
      renewedAt: "2026-10-15T01:50:00.000Z",
      expiresAt: "2026-10-15T02:50:00.000Z",
      next: "write the route",
    };
    const line = holderLine(h, NOW);
    expect(line.who).toMatch(/^Claim by iss-8-abc until \d\d:\d\d$/);
    expect(line.why).toBe("write the route");
    expect(line.since).toBe("Renewed 10m ago");
  });

  it("says a claim's next step and renewal were not recorded where they were not", () => {
    const h: Holder = { by: "claim", holder: "x", renewedAt: null, expiresAt: null, next: null };
    expect(holderLine(h, NOW)).toEqual({ who: "Claim by x", why: "No next step was recorded", since: "Renewal not recorded" });
  });

  it.each([
    ["information", "A person owes information"],
    ["decision", "A person owes a decision"],
    ["resource", "A person owes a resource"],
    [null, "A person — what is owed was not recorded"],
  ] as const)("names a person who owes %s", (owes, who) => {
    const h: Holder = { by: "person", status: "waiting", owes, since: null, why: "the vendor" };
    expect(holderLine(h, NOW)).toEqual({ who, why: "the vendor", since: "Start not recorded" });
  });

  it("says no reason was recorded, and reads an on_hold as paused by a person", () => {
    const h: Holder = { by: "person", status: "on_hold", owes: null, since: "2026-10-15T00:00:00.000Z", why: null };
    expect(holderLine(h, NOW)).toEqual({ who: "Paused by a person", why: "No reason was recorded", since: "2h ago" });
  });
});

describe("orderHolds — a person's holds first, then the longest held", () => {
  const held = (id: string, holders: Holder[]): HeldIssue => ({
    issueId: id,
    displayId: `ISS-${id}`,
    title: id,
    status: "in_progress",
    holders,
  });
  const sessionHold = (since: string): Holder => ({
    by: "session",
    sessionId: "s",
    sessionTitle: null,
    sessionKind: "run_session",
    deviceName: null,
    since,
  });

  it("puts a person's hold before an older session hold, then oldest first", () => {
    const person = held("1", [{ by: "person", status: "needs_info", owes: null, since: "2026-10-15T01:30:00.000Z", why: null }]);
    const old = held("2", [sessionHold("2026-10-14T00:00:00.000Z")]);
    const recent = held("3", [sessionHold("2026-10-15T01:00:00.000Z")]);
    expect(orderHolds([recent, old, person]).map((h) => h.issueId)).toEqual(["1", "2", "3"]);
  });

  it("sorts a hold with no recorded start last within its group", () => {
    const unknown = held("1", [{ by: "claim", holder: "x", renewedAt: null, expiresAt: null, next: null }]);
    const known = held("2", [sessionHold("2026-10-15T01:00:00.000Z")]);
    expect(orderHolds([unknown, known]).map((h) => h.issueId)).toEqual(["2", "1"]);
  });
});

describe("readAtLine", () => {
  it("names the clock time of the reading kept on screen", () => {
    expect(readAtLine("2026-10-15T01:59:00.000Z")).toMatch(/^Could not refresh — showing what was read at \d\d:\d\d\.$/);
  });
});
