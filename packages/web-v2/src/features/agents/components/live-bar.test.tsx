// @direct-test-of packages/web-v2/src/features/agents/now.ts
// REQ-15 BC-10 (ISS-856) as a person sees it: the bar on a project page says nothing runs and when
// the project last moved; names the master, the runs, a release and a room's turn, each a link; says
// "can't read" for a source that did not answer and never that nothing runs; and moves when a
// project-room frame says so, reading again only then. Its face is plain words in the person's
// language, with no issue key, room id, step or box on it: those sit in the tooltip and behind the
// link (ISS-864, ui-copy-rule 10).
import type { SupportTurnsView } from "@forge/contracts/project-now";
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/design";
import { InterfaceLanguageScope } from "@/lib/i18n/interface-language";
import { productCopy } from "@/lib/i18n/product-copy";
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
    passIssueTitle: null,
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
    step: { source: "work_state", step: "build", since: null },
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

const viCopy = productCopy("vi");
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const within = (ui: ReactElement, language: "en" | "vi") => (
  <InterfaceLanguageScope language={language}>
    <TooltipProvider delay={0}>{ui}</TooltipProvider>
  </InterfaceLanguageScope>
);
const mount = (qc = client(), language: "en" | "vi" = "en") => renderWithQuery(within(<LiveBar projectId={P} slug="forge" />, language), qc);
const bar = () => screen.getByTestId("live-bar");
const tip = () =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
    if (!el) throw new Error("no tooltip is shown");
    return el;
  });
/** What no face of the bar may carry: keys, room ids, boxes, raw steps. */
const CODES = /ISS-\d|GENERAL|HELP|box-a|\bbuild\b|\bdeploy\b|run_column/;

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
    // an idle master is what "nothing running" already says
    expect(bar().textContent).not.toContain("Master");
    expect(screen.queryByText("can't read", { exact: false })).toBeNull();
  });

  it("says so in the person's language", async () => {
    core({ live: list([]), recent: list([]), rooms: turns([]) });
    mount(client(), "vi");
    await waitFor(() => expect(bar().dataset.state).toBe("quiet"));
    expect(viCopy("agents.now.nothing")).not.toBe(productCopy("en")("agents.now.nothing"));
    expect(screen.getByTestId("live-bar-nothing").textContent).toContain(viCopy("agents.now.nothing"));
    cleanup();
    core({
      live: list([], master({ state: "in_pass", pass: { id: "p1", sessionId: "m1", verb: "dispatch", startedAt: minutesAgo(1), issueKey: "ISS-9", trigger: "nudge" }, passIssueTitle: "Fix the release page" })),
      recent: list([]),
      rooms: turns([{ roomId: "room-1", rid: "GENERAL", kind: "support", state: "answering", waiting: 0, waitingSince: null, lastActivityAt: minutesAgo(0) }]),
    });
    mount(client(), "vi");
    await waitFor(() => expect(bar().dataset.state).toBe("busy"));
    expect(bar().textContent).toContain(viCopy("agents.now.master.on", { title: "Fix the release page" }));
    expect(bar().textContent).toContain(viCopy("agents.now.answering"));
    expect(bar().textContent).not.toMatch(CODES);
  });

  it("names the master on its issue, each run, a release and a room's turn in words, each a link with its codes behind it", async () => {
    core({
      live: list(
        [
          run({}),
          run({ id: "r2", lane: "release", issue: null, release: { version: "1.4.0", stage: "deploy", verdict: null, attemptAt: null }, startedAt: minutesAgo(12) }),
        ],
        master({ state: "in_pass", pass: { id: "p1", sessionId: "m1", verb: "dispatch", startedAt: minutesAgo(1), issueKey: "ISS-9", trigger: "nudge" }, passIssueTitle: "Fix the release page" }),
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
    expect(href("Master working: Fix the release page")).toContain("/projects/forge/issues/ISS-9");
    expect(href("Build: Fix it")).toContain("/projects/forge/issues/ISS-5");
    expect(rows.textContent).toContain("4m");
    expect(href("Releasing 1.4.0")).toContain("/projects/forge/releases/1.4.0");
    expect(href("Bot answering")).toContain("/projects/forge/channels/GENERAL");
    expect(screen.queryByTestId("live-bar-nothing")).toBeNull();
    // no face carries a code; each sits in the item's tooltip
    expect(bar().textContent).not.toMatch(CODES);
    const [build] = screen.getAllByRole("link", { name: "Build: Fix it" });
    if (!build) throw new Error("no run link");
    await userEvent.setup().hover(build);
    expect((await tip()).textContent).toBe("ISS-5 · build · box-a");
  });

  it("says the master's work once when a run carries the issue it works", async () => {
    core({
      live: list([run({})], master({ state: "in_pass", pass: { id: "p1", sessionId: "m1", verb: "dispatch", startedAt: minutesAgo(1), issueKey: "ISS-5", trigger: "nudge" } })),
      recent: list([]),
      rooms: turns([]),
    });
    mount();
    await waitFor(() => expect(bar().dataset.state).toBe("busy"));
    expect(screen.getAllByTestId("live-bar-item")).toHaveLength(1);
    expect(bar().textContent).toContain("Master working: Fix it");
    expect(bar().textContent).toContain("4m");
    expect(bar().textContent).not.toMatch(CODES);
  });

  it("says can't read for a source that did not answer, and never that nothing runs", async () => {
    core({ live: list([]), recent: list([]), rooms: { status: 500 } });
    mount();
    await waitFor(() => expect(screen.getByTestId("live-bar-unreadable-rooms").textContent).toBe("Can't read chat rooms"));
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
    await waitFor(() => expect(screen.getByRole("link", { name: "Build: New" })).toBeTruthy());
    expect(bar().dataset.state).toBe("busy");
    expect(liveReads()).toBe(2);
    // a member's message waits in a room: only the rooms are read again
    world.rooms = turns([{ roomId: "room-1", rid: "HELP", kind: "support", state: "waiting", waiting: 2, waitingSince: minutesAgo(3), lastActivityAt: minutesAgo(0) }]);
    routeEvent({ event: "project.now.changed", data: { projectId: P, source: "rooms" }, timestamp: minutesAgo(0) }, qc);
    await waitFor(() => expect(bar().textContent).toContain("2 messages waiting"));
    expect(roomReads()).toBe(2);
    expect(liveReads()).toBe(2);
  });
});
