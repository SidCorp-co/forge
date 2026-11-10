// REQ-43 BC-14..BC-18 (owner, 2026-11-10): the project home opens on the loop, Product → Delivery →
// Release → Audit, each stage's figure the one home read's; pressing a stage opens its drawer with a
// picture and Esc closes it; Needs you stands on the home itself, above the charts; each chart reads
// as a table to a screen reader and offers no table toggle. Every figure comes from one request.
//
// @direct-test-of packages/web-v2/src/routes/_workspace/projects/$slug/index.tsx
// @direct-test-of packages/web-v2/src/features/project-home/

import type { ProjectHome } from "@forge/contracts/project-home";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore } from "@/test/render";
import { componentOf, renderRoute } from "@/test/route-tree";

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

import { Route as HomeRoute } from "@/routes/_workspace/projects/$slug/index";

const P = "3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11";
const project = { id: P, slug: "forge", name: "Forge", role: "admin", orgId: null, orgRole: null };
const AT = "2026-11-10T01:00:00.000Z";

const decision = {
  id: "q:1",
  group: "answer",
  area: "development",
  entity: "question",
  key: "q-1",
  title: "Which login provider ships first?",
  opens: { kind: "issue", key: "ISS-77" },
  question: "Which login provider ships first?",
  changes: "-",
  impact: "-",
  recommended: null,
  noRecommendation: "none",
  answers: [{ id: "a", label: "Google" }],
  touchedAt: AT,
  stuck: false,
  dueAt: null,
};

/** Oct 28 to Nov 10, the tenth day the busiest. */
const days = Array.from({ length: 14 }, (_, i) => ({ day: new Date(Date.UTC(2026, 9, 28 + i)).toISOString().slice(0, 10), releases: i % 3, issues: i === 10 ? 40 : i % 5 }));

function home(over: Partial<ProjectHome> = {}): ProjectHome {
  return {
    projectId: P,
    asOf: AT,
    tz: "UTC",
    product: {
      requirements: 12,
      byState: [
        { key: "agreed", count: 5 },
        { key: "in_delivery", count: 2 },
        { key: "accepted", count: 4 },
        { key: "draft", count: 1 },
      ],
      criteria: { proven: 36, total: 50 },
      areas: [{ name: "Delivery", requirements: 7, building: 1, proven: 20, total: 30 }],
      feedbackOpen: 3,
    },
    delivery: {
      open: 3,
      byStatus: [
        { key: "in_progress", count: 1 },
        { key: "on_hold", count: 1 },
        { key: "awaiting_release", count: 1 },
      ],
      running: 1,
      issues: [
        { key: "ISS-1", title: "The app shell loads attention, releases and needs-you on every page", titleLang: null, status: "in_progress", priority: "high", step: "test", touchedAt: AT, running: true },
        { key: "ISS-2", title: "forge-dev deploys as a docker-compose app", titleLang: null, status: "on_hold", priority: "medium", step: "build", touchedAt: AT, running: false },
        { key: "ISS-3", title: "An org-owned app routes by repository", titleLang: null, status: "awaiting_release", priority: "low", step: null, touchedAt: AT, running: false },
      ],
      truncated: false,
    },
    release: {
      days,
      shipped: days.reduce((n, d) => n + d.releases, 0),
      issues: days.reduce((n, d) => n + d.issues, 0),
      byState: [{ key: "shipped", count: 13 }, { key: "aborted", count: 1 }],
      timeline: [{ version: "0.4.0-dev.640", name: "Clearer home", issueCount: 4, releasedAt: AT }],
      recent: [{ version: "0.4.0-dev.640", name: "Clearer home", issueCount: 4, releasedAt: AT }],
    },
    audit: {
      open: 5,
      cleared: 2,
      byKind: [{ key: "red", count: 1 }, { key: "debt", count: 3 }, { key: "simplify", count: 1 }],
      byRating: [{ key: "low", count: 4 }, { key: "medium", count: 1 }],
      cells: [
        { type: "logic", kind: "debt", count: 3, places: [{ where: "standing.ts", count: 2 }, { where: "read.ts", count: 1 }] },
        { type: "logic", kind: "simplify", count: 1, places: [{ where: "read.ts", count: 1 }] },
        { type: "config", kind: "red", count: 1, places: [{ where: "check-copy-budget.mjs", count: 1 }] },
      ],
    },
    feedback: {
      weeks: ["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03", "2026-11-10"].map((week, i) => ({ week, fixed: i, declined: i % 2, open: 1 })),
    },
    needsYou: { decisions: [decision as never], total: 1 },
    ...over,
  };
}

function serve(read: ProjectHome): Call[] {
  return fakeCore((c) => {
    const path = c.path.split("?")[0] ?? "";
    if (path === "/projects") return { body: [project] };
    // the page leaves by the URL's slug at once, before the project list names its uuid
    if (path.endsWith("/home")) return { body: read };
    // anything else the page asks for is a read it should not send; answer it so the count says so
    return { body: {} };
  });
}

async function open(read: ProjectHome = home()) {
  const calls = serve(read);
  await renderRoute({ at: "/projects/forge", pattern: "/projects/$slug", page: componentOf(HomeRoute, "routes/_workspace/projects/$slug/index.tsx") });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  await screen.findByTestId("project-home");
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("the project home (REQ-43 BC-14..BC-18)", () => {
  it("opens on the loop, each stage's figure the read's, from one request", async () => {
    const calls = await open();
    const figure = (id: string) => screen.getByTestId(`home-stage-${id}-figure`).textContent;
    expect([figure("product"), figure("delivery"), figure("release"), figure("audit")]).toEqual(["72%", "3", String(home().release.shipped), "5"]);
    const reads = calls.map((c) => c.path.split("?")[0] ?? "").filter((p) => p !== "/projects");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatch(/^\/projects\/[^/]+\/home$/);
  });

  it("opens a stage's drawer with its picture on a press, and Esc closes it; nothing expands in place", async () => {
    await open();
    expect(screen.queryByTestId("home-board")).toBeNull();
    fireEvent.click(screen.getByTestId("home-stage-delivery"));
    const drawer = await screen.findByTestId("home-drawer-delivery");
    expect(within(drawer).getAllByTestId("home-issue-card")).toHaveLength(3);
    expect(within(drawer).getByTestId("home-board-building")).toHaveTextContent("1");
    expect(within(drawer).getByTestId("home-drawer-full")).toHaveAttribute("href", "/projects/forge/issues");
    expect(screen.getByTestId("project-home").contains(drawer)).toBe(false);
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("home-drawer-delivery")).toBeNull());

    fireEvent.click(screen.getByTestId("home-stage-audit"));
    expect(within(await screen.findByTestId("home-drawer-audit")).getAllByTestId("home-audit-cell").length).toBeGreaterThan(0);
  });

  it("draws Needs you on the home itself, above the charts, never only in a drawer", async () => {
    await open();
    const needs = screen.getAllByTestId("list-group").find((g) => g.getAttribute("data-group") === "needs") as HTMLElement;
    expect(within(needs).getByTestId("group-count").textContent).toBe("1");
    const row = screen.getByText("Which login provider ships first?");
    const home = screen.getByTestId("project-home");
    expect(home.contains(needs) && home.contains(row)).toBe(true);
    const charts = screen.getByTestId("home-chart-shipped");
    for (const el of [needs, row]) expect(el.compareDocumentPosition(charts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads each chart to a screen reader as a table, with no table toggle on screen", async () => {
    await open();
    const tables = screen.getAllByTestId("home-chart-table");
    expect(tables).toHaveLength(2);
    expect(within(tables[0]).getAllByRole("row")).toHaveLength(15);
    expect(screen.queryByRole("button", { name: /table/i })).toBeNull();
    expect(screen.queryByText(/^Data$/)).toBeNull();
  });

  it("says Nothing under Needs you, and quiet charts, for a project with nothing yet", async () => {
    const quiet = home({
      release: { ...home().release, days: days.map((d) => ({ ...d, releases: 0, issues: 0 })), shipped: 0, issues: 0, timeline: [], recent: [] },
      feedback: { weeks: home().feedback.weeks.map((w) => ({ ...w, fixed: 0, declined: 0, open: 0 })) },
      needsYou: { decisions: [], total: 0 },
    });
    await open(quiet);
    expect(screen.getByTestId("dashboard-needs-none")).toHaveTextContent("Nothing");
    expect(screen.getByTestId("home-chart-shipped")).toHaveTextContent("Nothing shipped");
  });
});
