// @direct-test-of packages/web-v2/src/features/agents/now.ts
// REQ-15 BC-10 (ISS-856) as a person sees it: the bar on a project page says nothing runs and when
// the project last moved; names the master, the runs, a release and a room's turn, each a link; says
// "can't read" for a source that did not answer and never that nothing runs; and moves when a
// project-room frame says so, reading again only then.
import type { SupportTurnsView } from "@forge/contracts/project-now";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, renderWithQuery } from "@/test/render";
import { routeEvent } from "@/lib/ws/event-router";
import type { MasterStanding, RunStanding, RunStandingList } from "../types";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({}));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {}, useRooms: () => {} }));

import { LiveBar } from "./live-bar";

const P = "11111111-1111-4111-8111-111111111111";
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const master = (over: Partial<MasterStanding> = {}): MasterStanding => ({
    generatedAt: minutesAgo(0),
    projectId: P,
    state: "idle",
    sessionId: "m1",
    name: "master",
    device: { id: "d1", name: "box-a" },
    since: null,
    pass: null,
    lastPass: null,
    slots: null,
    runsOut: 0,
    lastBeatAt: null,
    silentAfterSeconds: 600,
    waitingOn: null,
    dialogsAnswered: null,
  outdated: null,
  ...over,
});

const run = (over: Partial<RunStanding>): RunStanding =>
  ({
    id: "r1",
    lane: "issue",
    state: "running",
    issue: { key: "ISS-5", title: "Fix it", status: "in_progress" },
    title: "Fix it",
    says: { title: { key: "verbatim", text: "Fix it" }, rule: { key: "verbatim", text: "" } },
    step: { source: "run_column", step: "build", since: null },
    startedAt: minutesAgo(4),
    finishedAt: null,
    device: { id: "d1", name: "box-a" },
    release: null,
    deployLocks: [],
    ...over,
  }) as unknown as RunStanding;

const list = (items: RunStanding[], m = master()): RunStandingList => ({ items, master: m }) as unknown as RunStandingList;
const turns = (rooms: SupportTurnsView["rooms"]): SupportTurnsView => ({ generatedAt: minutesAgo(0), projectId: P, rooms });

interface World {
  live: RunStandingList;
  recent: RunStandingList;
  rooms: SupportTurnsView | { status: number };
}

function core(world: World): Call[] {
  return fakeCore((call) => {
    if (call.path.startsWith(`/projects/${P}/runs/standing?scope=live`)) return { body: world.live };
    if (call.path.startsWith(`/projects/${P}/runs/standing?scope=finished`)) return { body: world.recent };
    if (call.path === `/projects/${P}/support/turns`) {
      return "status" in world.rooms ? { status: world.rooms.status, body: { code: "BOOM", message: "down" } } : { body: world.rooms };
    }
    return undefined;
  });
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const mount = (qc = client()) => renderWithQuery(<LiveBar projectId={P} slug="forge" />, qc);
const bar = () => screen.getByTestId("live-bar");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the project bar (REQ-15 BC-10)", () => {
  it("says nothing runs, with the time the project last moved", async () => {
    const ended = "2026-11-01T09:41:00Z";
    core({ live: list([]), recent: list([run({ state: "done", finishedAt: ended })]), rooms: turns([]) });
    mount();
    await waitFor(() => expect(bar().dataset.state).toBe("quiet"));
    const nothing = screen.getByTestId("live-bar-nothing");
    expect(nothing.textContent).toContain("Nothing running");
    expect(nothing.textContent).toMatch(/last activity \d{2}:\d{2}/);
    expect(bar().textContent).toContain("idle");
    expect(screen.queryByText("can't read", { exact: false })).toBeNull();
  });

  it("names the master on its issue, each run, a release and a room's turn, each a link", async () => {
    core({
      live: list(
        [
          run({}),
          run({ id: "r2", lane: "release", issue: null, release: { version: "1.4.0", stage: "deploy", verdict: null, attemptAt: null }, startedAt: minutesAgo(12) }),
        ],
        master({ state: "in_pass", pass: { id: "p1", sessionId: "m1", verb: "dispatch", startedAt: minutesAgo(1), issueKey: "ISS-9", trigger: "nudge" } }),
      ),
      recent: list([]),
      rooms: turns([{ roomId: "room-1", rid: "GENERAL", kind: "support", state: "answering", waiting: 0, waitingSince: null, lastActivityAt: minutesAgo(0) }]),
    });
    mount();
    await waitFor(() => expect(bar().dataset.state).toBe("busy"));
    // collapsed: one line naming the first items and counting the rest
    expect(screen.getAllByTestId("live-bar-item")).toHaveLength(3);
    expect(bar().textContent).toContain("+1");
    fireEvent.click(screen.getByRole("button", { name: "Show all" }));
    const rows = screen.getByTestId("live-bar-list");
    const href = (name: string) => screen.getAllByRole("link", { name }).map((a) => a.getAttribute("href"));
    expect(href("Master")).toContain("/projects/forge/agents/master");
    expect(rows.textContent).toContain("working");
    expect(href("ISS-9")).toContain("/projects/forge/issues/ISS-9");
    expect(href("ISS-5")).toContain("/projects/forge/issues/ISS-5");
    expect(rows.textContent).toContain("build");
    expect(rows.textContent).toContain("4m");
    expect(rows.textContent).toContain("box-a");
    expect(href("Release 1.4.0")).toContain("/projects/forge/releases/1.4.0");
    expect(rows.textContent).toContain("deploy");
    expect(href("Room GENERAL")).toContain("/projects/forge/channels/GENERAL");
    expect(rows.textContent).toContain("answering");
    expect(screen.queryByTestId("live-bar-nothing")).toBeNull();
  });

  it("says can't read for a source that did not answer, and never that nothing runs", async () => {
    core({ live: list([]), recent: list([]), rooms: { status: 500 } });
    mount();
    await waitFor(() => expect(screen.getByTestId("live-bar-unreadable-rooms").textContent).toBe("Rooms can't read"));
    expect(bar().dataset.state).toBe("unreadable");
    expect(screen.queryByTestId("live-bar-nothing")).toBeNull();
    expect(bar().textContent).not.toContain("Nothing running");
  });

  it("moves on a project-room frame without a reload, and reads nothing again without one", async () => {
    const world: World = { live: list([]), recent: list([]), rooms: turns([]) };
    const calls = core(world);
    const qc = client();
    mount(qc);
    await waitFor(() => expect(bar().dataset.state).toBe("quiet"));
    const liveReads = () => calls.filter((c) => c.path.includes("scope=live")).length;
    const roomReads = () => calls.filter((c) => c.path.endsWith("/support/turns")).length;
    expect(liveReads()).toBe(1);
    // no frame: nothing is read again, however long the page stays open
    await new Promise((r) => setTimeout(r, 400));
    expect(liveReads()).toBe(1);
    // a run is declared on an issue: core tells the project room
    world.live = list([run({ issue: { key: "ISS-7", title: "New", status: "in_progress" } })]);
    routeEvent({ event: "project.now.changed", data: { projectId: P, source: "runs" }, timestamp: minutesAgo(0) }, qc);
    await waitFor(() => expect(screen.getByRole("link", { name: "ISS-7" })).toBeTruthy());
    expect(bar().dataset.state).toBe("busy");
    expect(liveReads()).toBe(2);
    // a member's message waits in a room: only the rooms are read again
    world.rooms = turns([{ roomId: "room-1", rid: "HELP", kind: "support", state: "waiting", waiting: 2, waitingSince: minutesAgo(3), lastActivityAt: minutesAgo(0) }]);
    routeEvent({ event: "project.now.changed", data: { projectId: P, source: "rooms" }, timestamp: minutesAgo(0) }, qc);
    await waitFor(() => expect(bar().textContent).toContain("2 waiting"));
    expect(roomReads()).toBe(2);
    expect(liveReads()).toBe(2);
  });
});
