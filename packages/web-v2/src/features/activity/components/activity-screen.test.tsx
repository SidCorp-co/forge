// ISS-951 (MK-8, MK-9, then MK-10 C, the timeline the owner chose): the workspace's Activity tab draws
// one lane per project in core's groups (Running · Idle with backlog · Waiting on a person · Quiet):
// its passes as ticks, runs and dialogs as bars and status moves as dots over two hours, its name with
// what it does or why it took nothing, and its pane badge and how fresh that is, or "Last pass HH:MM"
// where no live facts stand. It filters by the strip, opens one project's peek (Now, Backlog, People,
// a dialog's text, both release counts, a Recent list read only when opened) that the arrow keys
// switch and Esc closes, listens on the org's room, keeps its last answer on screen while it reads
// again, and never shows a slug or an id.
//
// @direct-test-of packages/web-v2/src/features/activity/components/lanes.tsx
// @direct-test-of packages/web-v2/src/design/patterns/timeline.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/activity-peek.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/pane.tsx
// @direct-test-of packages/web-v2/src/features/activity/hooks.ts
// @direct-test-of packages/web-v2/src/features/activity/api.ts
// @direct-test-of packages/web-v2/src/features/activity/index.ts
// @direct-test-of packages/web-v2/src/lib/ws/rooms.ts
// @direct-test-of packages/web-v2/src/lib/ws/event-router.ts
// @direct-test-of packages/web-v2/src/routes/_workspace/activity/index.tsx

import type { OrgActivity, OrgActivityMaster, OrgActivityProject, OrgActivityRecent } from "@forge/contracts/org-activity";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore, HANG, renderWithQuery } from "@/test/render";

const rooms: string[] = [];
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: (room: string | null) => void (room && rooms.push(room)) }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: ORG }) }));

const ORG = "0d1b2c3d-0000-4000-8000-000000000001";
const QUESTION_ID = "80ed3d9e-0c25-40e0-b984-6ae230a9c4d6";
const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
const LANE_EMPTY = { from: ago(7200), passes: [], runs: [], moves: [], dialogs: [] };

const master = (over: Partial<OrgActivityMaster> = {}): OrgActivityMaster => ({
  state: "idle",
  since: null,
  lastPassEndedAt: null,
  lastBeatAt: ago(20),
  silentAfterSeconds: 300,
  pane: null,
  doing: null,
  dialog: null,
  ...over,
});

const project = (over: Partial<OrgActivityProject> & Pick<OrgActivityProject, "projectId" | "slug" | "name" | "group">): OrgActivityProject => ({
  master: master(),
  now: [],
  next: { total: 0, items: [], skip: null },
  people: { total: 0, items: [] },
  peoplePending: false,
  release: null,
  releasePending: false,
  awaitingRelease: 0,
  lane: over.master?.state === "none" ? null : LANE_EMPTY,
  ...over,
});

const FORGE = project({
  projectId: "p-forge",
  slug: "forge-slug",
  name: "Forge",
  group: "running",
  master: master({
    state: "busy",
    lastBeatAt: ago(12),
    pane: { doing: "working", lastEventAt: ago(12), turnBeganAt: ago(40), writtenAt: null, seenAt: ago(12), source: "beat" },
    doing: { kind: "pass", verb: "dispatch", issueKey: "ISS-687" },
  }),
  now: [{ issueId: "i-948", key: "ISS-948", title: "The demo seed asks a steward decision", status: "in_progress", step: "build", stepSince: ago(17 * 60) }],
  next: { total: 10, items: [{ issueId: "i-935", key: "ISS-935", title: "The steward names the events door", priority: "medium" }], skip: null },
  people: { total: 43, items: [{ group: "answer", key: "ISS-103", title: "Can the stg vhost be changed today, or only in the Friday window?" }] },
  release: { key: "REQ-40", title: "Every release is a readable page", shipped: 7, awaitingRelease: 0, total: 8 },
  lane: {
    from: ago(7200),
    passes: [ago(6600), ago(3600), ago(600)],
    runs: [{ from: ago(5400), to: ago(4200) }, { from: ago(1800), to: null }],
    moves: [ago(4200), ago(300)],
    dialogs: [{ from: ago(2400), to: ago(2100) }],
  },
});
const ADMINHUB = project({
  projectId: "p-ahfe",
  slug: "ahfe-slug",
  name: "AdminHub FE",
  group: "idle",
  master: master({ state: "idle", lastBeatAt: ago(20), lastPassEndedAt: "2026-11-04T08:32:00.000Z", pane: { doing: "working", lastEventAt: ago(600), turnBeganAt: null, writtenAt: null, seenAt: ago(55), source: "pass" } }),
  next: { total: 2, items: [], skip: "one_at_a_time" },
  people: { total: 5, items: [{ group: "answer", key: null, title: "Which agent template should replication copy?" }] },
});
const AHAPI = project({
  projectId: "p-ahapi",
  slug: "ahapi-slug",
  name: "AdminHub API",
  group: "waiting",
  master: master({ state: "waiting_person", dialog: "Allow Bash: curl -sS https://staging.example ?", pane: { doing: "idle", lastEventAt: ago(80), turnBeganAt: null, writtenAt: null, seenAt: ago(80), source: "pass" } }),
});
const CATALOG = project({
  projectId: "p-cat",
  slug: "catalog-slug",
  name: "Catalog API",
  group: "waiting",
  master: master({ state: "none", lastBeatAt: null }),
  awaitingRelease: 44,
  release: { key: "REQ-4", title: "Two-way site sync", shipped: 7, awaitingRelease: 7, total: 15 },
});
const SILENT = project({
  projectId: "p-orbit",
  slug: "orbit-slug",
  name: "Orbit",
  group: "idle",
  master: master({ state: "silent", lastBeatAt: ago(540) }),
});
const QUIET = project({ projectId: "p-q", slug: "quiet-slug", name: "SidDesk", group: "quiet" });

const read = (projects: OrgActivityProject[], refreshing = false): OrgActivity => ({
  generatedAt: new Date().toISOString(),
  orgId: ORG,
  projects,
  refreshing,
  totals: {
    projects: projects.length,
    running: projects.filter((p) => p.group === "running").length,
    inFlight: projects.reduce((n, p) => n + p.now.length, 0),
    queued: projects.reduce((n, p) => n + p.next.total, 0),
    people: projects.reduce((n, p) => n + p.people.total, 0),
    awaitingRelease: projects.reduce((n, p) => n + p.awaitingRelease, 0),
    noMaster: projects.filter((p) => p.master.state === "none").length,
  },
});

const RECENT: OrgActivityRecent = {
  projectId: "p-forge",
  items: [
    { at: ago(60), kind: "run_started", issueKey: "ISS-688" },
    { at: ago(300), kind: "pass_settled", issueKey: null, verb: "dispatch", dispatched: 1 },
    { at: ago(900), kind: "change_request", issueKey: "ISS-933", ref: "!135" },
  ],
};

import { routeEvent } from "@/lib/ws/event-router";
import { ActivityScreen } from "./activity-screen";

function serve(body: OrgActivity) {
  return fakeCore((call) => {
    if (call.path === `/orgs/${ORG}/activity`) return { body };
    if (call.path === `/orgs/${ORG}/activity/p-forge/recent`) return { body: RECENT };
    return undefined;
  });
}

beforeEach(() => {
  rooms.length = 0;
  window.history.replaceState(null, "", "/activity");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rowOf = (name: string) => {
  const row = screen.getAllByTestId("list-row").find((r) => r.textContent?.includes(name));
  if (!row) throw new Error(`no row for ${name}`);
  return row;
};

describe("the Activity tab", () => {
  it("draws core's rows in core's groups and listens on the org's room", async () => {
    serve(read([FORGE, ADMINHUB, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const groups = screen.getAllByTestId("list-group").map((g) => g.getAttribute("data-group"));
    expect(groups).toEqual(["running", "idle", "waiting", "quiet"]);
    expect(rooms).toContain(`org:${ORG}`);
  });

  it("shows no slug or id as text; the issue keys it shows are the ones a person reads", async () => {
    serve(read([FORGE, ADMINHUB, CATALOG, QUIET]));
    const { container } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    fireEvent.click(rowOf("Forge"));
    await screen.findByTestId("activity-peek");
    const text = container.ownerDocument.body.textContent ?? "";
    for (const raw of ["forge-slug", "p-forge", "i-948", ORG, QUESTION_ID]) {
      expect(text, `${raw} is drawn as text`).not.toContain(raw);
    }
  });

  it("a question waiting on the reader reads as its own words with its issue key", async () => {
    serve(read([FORGE, ADMINHUB]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    fireEvent.click(rowOf("Forge"));
    const people = within(await screen.findByTestId("activity-peek")).getByRole("region", { name: "People" });
    const item = within(people).getByTestId("row-item");
    expect(item.textContent).toContain("ISS-103");
    expect(item.textContent).toContain("Can the stg vhost be changed today, or only in the Friday window?");
    expect(people.textContent).not.toContain("A question a run asked");
  });

  it("the strip keeps only the rows its filter names", async () => {
    serve(read([FORGE, ADMINHUB, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(screen.getByTestId("activity-show-running").textContent).toContain("1");
    fireEvent.click(screen.getByTestId("activity-show-running"));
    await waitFor(() => expect(screen.getAllByTestId("list-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("activity-show-noMaster"));
    await waitFor(() => expect(screen.getAllByTestId("list-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Catalog API")]));
  });

  it("the peek shows Now, Backlog and People; the arrow keys switch project and Esc closes", async () => {
    serve(read([FORGE, ADMINHUB, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    fireEvent.click(rowOf("Forge"));
    const peek = await screen.findByTestId("activity-peek");
    expect(within(peek).getByText("The demo seed asks a steward decision")).toBeTruthy();
    expect(within(peek).getByText("The steward names the events door")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(within(screen.getByTestId("activity-peek")).getByTestId("peek-head").textContent).toContain("AdminHub FE"));
    expect(within(screen.getByTestId("activity-peek")).getByTestId("activity-skip-line").textContent).toBe("Took nothing: one at a time");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("activity-peek")).toBeNull());
  });

  it("a waiting dialog's text is in the peek, under its Dialog badge", async () => {
    serve(read([AHAPI]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("AdminHub API");
    fireEvent.click(rowOf("AdminHub API"));
    const peek = await screen.findByTestId("activity-peek");
    expect(within(peek).getByTestId("activity-dialog").textContent).toBe("Allow Bash: curl -sS https://staging.example ?");
    expect(within(peek).getByTestId("activity-pane").getAttribute("data-pane")).toBe("dialog");
  });

  it("Recent is closed until clicked, and only then reads the project's events", async () => {
    const calls = serve(read([FORGE]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(calls.some((c) => c.path.endsWith("/recent")), "the list read Recent").toBe(false);
    fireEvent.click(rowOf("Forge"));
    const recent = within(await screen.findByTestId("activity-peek")).getByTestId("activity-recent");
    expect(recent.hasAttribute("open")).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/recent")), "a closed Recent was read").toBe(false);
    fireEvent.click(within(recent).getByText("Recent"));
    await waitFor(() => expect(within(recent).getAllByTestId("row-item")).toHaveLength(3));
    expect(recent.textContent).toContain("Run started · ISS-688");
    expect(recent.textContent).toContain("Pass settled · dispatched 1");
    expect(recent.textContent).toContain("Change request !135 · ISS-933");
  });

  it("an org with no project the reader can read says so", async () => {
    serve(read([]));
    renderWithQuery(<ActivityScreen />);
    expect(await screen.findByText("No projects")).toBeTruthy();
    expect(screen.queryByTestId("activity-lanes")).toBeNull();
  });

  it("reads again when the org's room says a project moved, keeping the last answer on screen meanwhile", async () => {
    let body = read([FORGE, QUIET]);
    let hang = false;
    const calls = fakeCore((call) => (call.path === `/orgs/${ORG}/activity` ? (hang ? HANG : { body }) : undefined));
    const { client } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const reads = () => calls.filter((c) => c.path === `/orgs/${ORG}/activity`).length;
    expect(reads()).toBe(1);
    const moved = (orgId: string) =>
      routeEvent({ event: "org.activity.changed", data: { orgId, projectId: "p-q", source: "master" }, timestamp: new Date().toISOString() }, client);
    moved("another-org");
    await new Promise((r) => setTimeout(r, 400));
    expect(reads(), "another org's frame read this page again").toBe(1);
    body = read([FORGE, { ...QUIET, group: "running", master: master({ state: "busy" }) }]);
    moved(ORG);
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(screen.getAllByTestId("list-group").map((g) => g.getAttribute("data-group"))).toEqual(["running"]));
    hang = true;
    moved(ORG);
    await waitFor(() => expect(reads()).toBe(3));
    await waitFor(() => expect(screen.getByTestId("activity-updating").textContent).toBe("updating"));
    expect(screen.getByText("Forge"), "the last answer left the screen while it read again").toBeTruthy();
    expect(screen.queryByText("loading activity…")).toBeNull();
  });

  it("reads once more while core says it is still reading behind its answer, and stops when it is not", async () => {
    let refreshing = true;
    const calls = fakeCore((call) => (call.path === `/orgs/${ORG}/activity` ? { body: read([FORGE], refreshing) } : undefined));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const reads = () => calls.filter((c) => c.path === `/orgs/${ORG}/activity`).length;
    refreshing = false;
    await waitFor(() => expect(reads()).toBe(2), { timeout: 5_000 });
    await new Promise((r) => setTimeout(r, 3_500));
    expect(reads(), "the page went on reading after core said it was done").toBe(2);
  }, 12_000);
});

describe("the Activity tab's lanes", () => {
  it("each lane shows its pane badge and how fresh its facts are, and what it does by name", async () => {
    serve(read([FORGE, AHAPI, CATALOG, SILENT]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const forge = rowOf("Forge");
    expect(within(forge).getByTestId("activity-pane").getAttribute("data-pane")).toBe("busy");
    expect(within(forge).getByTestId("activity-ago").textContent).toMatch(/^\d+s ago$/);
    expect(within(forge).getByTestId("activity-ago").getAttribute("data-late")).toBeNull();
    expect(within(forge).getByTestId("activity-doing").textContent).toBe("DispatchISS-687");
    expect(within(rowOf("AdminHub API")).getByTestId("activity-pane").getAttribute("data-pane")).toBe("dialog");
    expect(within(rowOf("Catalog API")).getByTestId("activity-pane").getAttribute("data-pane")).toBe("none");
    const silent = within(rowOf("Orbit"));
    expect(silent.getByTestId("activity-pane").getAttribute("data-pane")).toBe("silent");
    expect(silent.getByTestId("activity-ago").textContent).toBe("9 min ago");
    expect(silent.getByTestId("activity-ago").getAttribute("data-late"), "a box silent past the limit read as live").toBe("true");
  });

  it("a pane known only as of its last pass makes no Idle or Busy claim: it says when the last pass was", async () => {
    serve(read([ADMINHUB]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("AdminHub FE");
    const row = within(rowOf("AdminHub FE"));
    const pane = row.getByTestId("activity-pane");
    expect(pane.getAttribute("data-pane"), "a pane as of its last pass read as live").toBe("pass");
    expect(pane.textContent).not.toMatch(/Idle|Busy/);
    // in the viewer's time, as a clock: never as an age
    expect(row.getByTestId("activity-last-pass").textContent).toMatch(/^Last pass \d{1,2}:\d{2}( [AP]M)?$/);
    // the box spoke 20 s ago, but that says nothing of what the pane does: no fresh-looking age
    expect(row.queryByTestId("activity-ago")).toBeNull();
  });

  it("live pane facts older than the silence limit show their age in red, and no badge", async () => {
    const stale = project({
      projectId: "p-st",
      slug: "st-slug",
      name: "Stale",
      group: "idle",
      master: master({ state: "idle", lastBeatAt: ago(20), pane: { doing: "working", lastEventAt: ago(900), turnBeganAt: null, writtenAt: null, seenAt: ago(600), source: "beat" } }),
    });
    serve(read([stale]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Stale");
    const row = within(rowOf("Stale"));
    expect(row.getByTestId("activity-pane").getAttribute("data-pane")).toBe("pass");
    expect(row.getByTestId("activity-ago").textContent).toBe("10 min ago");
    expect(row.getByTestId("activity-ago").getAttribute("data-late")).toBe("true");
  });

  it("a lane draws its passes as ticks, its runs and dialogs as bars and its status moves as dots", async () => {
    serve(read([FORGE, CATALOG]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const lane = within(within(rowOf("Forge")).getByTestId("timeline-track"));
    expect(lane.getAllByTestId("timeline-tick")).toHaveLength(3);
    expect(lane.getAllByTestId("timeline-dot")).toHaveLength(2);
    const bars = lane.getAllByTestId("timeline-bar");
    expect(bars.map((b) => b.getAttribute("data-tone"))).toEqual(["run", "run", "wait"]);
    // a pass 10 minutes before the read's now sits about 92% of the way along two hours
    expect(Number.parseFloat(lane.getAllByTestId("timeline-tick")[2]?.style.left ?? "")).toBeCloseTo(91.7, 0);
    // a run still running reaches the now edge; one that ended stops where it ended
    expect(Number.parseFloat(bars[1]?.style.right ?? "")).toBeCloseTo(0, 0);
    expect(Number.parseFloat(bars[0]?.style.right ?? "")).toBeCloseTo(58.3, 0);
    const none = within(rowOf("Catalog API"));
    expect(none.getByTestId("timeline-empty").textContent).toBe("no master");
    expect(none.queryByTestId("timeline-tick")).toBeNull();
  });

  it("the left column says why an idle master took nothing", async () => {
    serve(read([ADMINHUB]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("AdminHub FE");
    expect(within(rowOf("AdminHub FE")).getByTestId("activity-skip").textContent).toBe("one at a time");
  });

  it("with the peek open, every lane keeps its name, its badge and its track: no column is dropped", async () => {
    serve(read([FORGE, ADMINHUB, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    fireEvent.click(rowOf("Forge"));
    await screen.findByTestId("activity-peek");
    for (const row of screen.getAllByTestId("list-row")) {
      expect(within(row).getByTestId("activity-pane")).toBeTruthy();
      expect(within(row).getByTestId("timeline-track")).toBeTruthy();
      for (const cell of [row, ...row.querySelectorAll("*")]) {
        expect(cell.className.toString(), "a lane's cell is hidden at a narrower list").not.toMatch(/max-(lg|xl|md):hidden/);
      }
    }
  });

  it("the peek labels both release counts", async () => {
    serve(read([CATALOG]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Catalog API");
    fireEvent.click(rowOf("Catalog API"));
    const peek = await screen.findByTestId("activity-peek");
    expect(within(peek).getByRole("region", { name: "To release" }).textContent).toBe("To release44");
    expect(within(peek).getByTestId("activity-release").textContent).toContain("7/15");
  });
});

describe("the peek's Recent list", () => {
  it("answers while the org's room moves faster than Recent reads: a frame does not cancel its read", async () => {
    const calls: string[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const path = new URL(input, "http://forge.test").pathname.replace(/^\/api/, "");
        calls.push(path);
        if (path === `/orgs/${ORG}/activity`) return json(read([FORGE]));
        // Recent takes longer than the room's frames come
        await new Promise((r) => setTimeout(r, 600));
        return json(RECENT);
      }),
    );
    const { client } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    fireEvent.click(rowOf("Forge"));
    const recent = within(await screen.findByTestId("activity-peek")).getByTestId("activity-recent");
    fireEvent.click(within(recent).getByText("Recent"));
    const frames = setInterval(() => {
      routeEvent({ event: "org.activity.changed", data: { orgId: ORG, projectId: "p-forge", source: "master" }, timestamp: new Date().toISOString() }, client);
    }, 150);
    try {
      await waitFor(() => expect(within(recent).getAllByTestId("row-item")).toHaveLength(3), { timeout: 4_000 });
    } finally {
      clearInterval(frames);
    }
    expect(calls.filter((c) => c.endsWith("/recent")), "each frame cancelled Recent's read and started it again").toHaveLength(1);
  }, 10_000);
});
