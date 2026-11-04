// ISS-951 (MK-8): the workspace's Activity tab draws core's rows in core's groups, names and counts
// only, filters by the strip, opens one project's peek (Now, Next, People by title) that the arrow
// keys switch and Esc closes, listens on the org's room, and never shows a raw key, slug or id.
//
// @direct-test-of packages/web-v2/src/features/activity/components/activity-peek.tsx
// @direct-test-of packages/web-v2/src/features/activity/hooks.ts
// @direct-test-of packages/web-v2/src/features/activity/api.ts
// @direct-test-of packages/web-v2/src/features/activity/index.ts
// @direct-test-of packages/web-v2/src/lib/ws/rooms.ts
// @direct-test-of packages/web-v2/src/lib/ws/event-router.ts
// @direct-test-of packages/web-v2/src/routes/_workspace/activity/index.tsx

import type { OrgActivity, OrgActivityProject } from "@forge/contracts/org-activity";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore, renderWithQuery } from "@/test/render";

const rooms: string[] = [];
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: (room: string | null) => void (room && rooms.push(room)) }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: ORG }) }));

const ORG = "0d1b2c3d-0000-4000-8000-000000000001";

const project = (over: Partial<OrgActivityProject> & Pick<OrgActivityProject, "projectId" | "slug" | "name" | "group">): OrgActivityProject => ({
  master: { state: "idle", since: null, lastPassEndedAt: null, lastBeatAt: null },
  now: [],
  next: { total: 0, items: [] },
  people: { total: 0, items: [] },
  release: null,
  awaitingRelease: 0,
  ...over,
});

const FORGE = project({
  projectId: "p-forge",
  slug: "forge-slug",
  name: "Forge",
  group: "working",
  master: { state: "in_pass", since: null, lastPassEndedAt: null, lastBeatAt: null },
  now: [{ issueId: "i-948", key: "ISS-948", title: "The demo seed asks a steward decision", status: "in_progress", step: "build", stepSince: new Date(Date.now() - 17 * 60_000).toISOString() }],
  next: { total: 10, items: [{ issueId: "i-935", key: "ISS-935", title: "The steward names the events door", priority: "medium" }] },
  people: { total: 43, items: [{ group: "answer", key: "REQ-77", title: "A channel agent answers each bound channel" }] },
  release: { key: "REQ-40", title: "Every release is a readable page", shipped: 7, awaitingRelease: 0, total: 8 },
});
const EPOD = project({ projectId: "p-epod", slug: "epod-slug", name: "EpodSystem", group: "idle", next: { total: 1, items: [] }, people: { total: 10, items: [] } });
const CATALOG = project({
  projectId: "p-cat",
  slug: "catalog-slug",
  name: "Catalog API",
  group: "waiting",
  master: { state: "none", since: null, lastPassEndedAt: null, lastBeatAt: null },
  awaitingRelease: 44,
});
const QUIET = project({ projectId: "p-q", slug: "quiet-slug", name: "SidDesk", group: "quiet" });

const read = (projects: OrgActivityProject[]): OrgActivity => ({
  generatedAt: new Date().toISOString(),
  orgId: ORG,
  projects,
  totals: {
    projects: projects.length,
    inFlight: projects.reduce((n, p) => n + p.now.length, 0),
    queued: projects.reduce((n, p) => n + p.next.total, 0),
    people: projects.reduce((n, p) => n + p.people.total, 0),
    awaitingRelease: projects.reduce((n, p) => n + p.awaitingRelease, 0),
    noMaster: projects.filter((p) => p.master.state === "none").length,
  },
});

import { routeEvent } from "@/lib/ws/event-router";
import { ActivityScreen } from "./activity-screen";

function serve(body: OrgActivity) {
  return fakeCore((call) => (call.path === `/orgs/${ORG}/activity` ? { body } : undefined));
}

beforeEach(() => {
  rooms.length = 0;
  window.history.replaceState(null, "", "/activity");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Activity tab", () => {
  it("draws core's rows in core's groups and listens on the org's room", async () => {
    serve(read([FORGE, EPOD, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const groups = screen.getAllByTestId("list-group").map((g) => g.getAttribute("data-group"));
    expect(groups).toEqual(["working", "idle", "waiting", "quiet"]);
    expect(screen.getAllByTestId("list-row").map((r) => r.textContent?.match(/Forge|EpodSystem|Catalog API|SidDesk/)?.[0])).toEqual(["Forge", "EpodSystem", "Catalog API", "SidDesk"]);
    expect(rooms).toContain(`org:${ORG}`);
  });

  it("shows no raw key, slug or id as text", async () => {
    serve(read([FORGE, EPOD, CATALOG, QUIET]));
    const { container } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    fireEvent.click(screen.getAllByTestId("list-row")[0]);
    await screen.findByTestId("activity-peek");
    const text = container.ownerDocument.body.textContent ?? "";
    for (const raw of ["ISS-948", "ISS-935", "REQ-77", "REQ-40", "forge-slug", "p-forge", "i-948", ORG]) {
      expect(text, `${raw} is drawn as text`).not.toContain(raw);
    }
  });

  it("counts Now, Next and People on the row, the release as shipped of total, and what waits for a release", async () => {
    serve(read([FORGE, CATALOG]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const [forge, catalog] = screen.getAllByTestId("list-row");
    if (!forge || !catalog) throw new Error("the two rows were not drawn");
    const counts = within(forge).getByTestId("activity-counts");
    expect(within(counts).getByLabelText("Now 1")).toBeTruthy();
    expect(within(counts).getByLabelText("Next 10")).toBeTruthy();
    expect(within(counts).getByLabelText("People 43")).toBeTruthy();
    expect(within(forge).getByTestId("activity-release").textContent).toContain("7/8");
    expect(within(catalog).getByText("44")).toBeTruthy();
  });

  it("the strip keeps only the rows its filter names", async () => {
    serve(read([FORGE, EPOD, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    expect(screen.getByTestId("activity-show-inFlight").textContent).toContain("1");
    fireEvent.click(screen.getByTestId("activity-show-inFlight"));
    await waitFor(() => expect(screen.getAllByTestId("list-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("activity-show-noMaster"));
    await waitFor(() => expect(screen.getAllByTestId("list-row").map((r) => r.textContent)).toEqual([expect.stringContaining("Catalog API")]));
  });

  it("a row opens its peek by title; the arrow keys switch project and Esc closes", async () => {
    serve(read([FORGE, EPOD, CATALOG, QUIET]));
    renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    fireEvent.click(screen.getAllByTestId("list-row")[0]);
    const peek = await screen.findByTestId("activity-peek");
    expect(within(peek).getByText("The demo seed asks a steward decision")).toBeTruthy();
    expect(within(peek).getByText("The steward names the events door")).toBeTruthy();
    expect(within(peek).getByText("A channel agent answers each bound channel")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(within(screen.getByTestId("activity-peek")).getByTestId("peek-head").textContent).toContain("EpodSystem"));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("activity-peek")).toBeNull());
  });

  it("an org with no project the reader can read says so", async () => {
    serve(read([]));
    renderWithQuery(<ActivityScreen />);
    expect(await screen.findByText("No projects you can read here")).toBeTruthy();
    expect(screen.queryByTestId("grouped-list")).toBeNull();
  });

  it("reads again when the org's room says a project moved, and only for its own org", async () => {
    let body = read([FORGE, QUIET]);
    const calls = fakeCore((call) => (call.path === `/orgs/${ORG}/activity` ? { body } : undefined));
    const { client } = renderWithQuery(<ActivityScreen />);
    await screen.findByText("Forge");
    const reads = () => calls.filter((c) => c.path === `/orgs/${ORG}/activity`).length;
    expect(reads()).toBe(1);
    routeEvent({ event: "org.activity.changed", data: { orgId: "another-org", projectId: "p-x", source: "step" }, timestamp: new Date().toISOString() }, client);
    await new Promise((r) => setTimeout(r, 400));
    expect(reads(), "another org's frame read this page again").toBe(1);
    body = read([{ ...QUIET, group: "working", now: [{ issueId: "i-1", key: "ISS-1", title: "Now it works", status: "in_progress", step: "test", stepSince: new Date().toISOString() }] }]);
    routeEvent({ event: "org.activity.changed", data: { orgId: ORG, projectId: "p-q", source: "step" }, timestamp: new Date().toISOString() }, client);
    await waitFor(() => expect(reads()).toBe(2));
    await waitFor(() => expect(screen.queryByText("Forge")).toBeNull());
    expect(screen.getAllByTestId("list-group").map((g) => g.getAttribute("data-group"))).toEqual(["working"]);
  });
});
