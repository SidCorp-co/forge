// ISS-1067: the project Dashboard is the one-project view of Activity. It draws Needs you, Moving,
// Shipped and Stuck as one shared grouped list, in that order, and one Audit line where a cleanup
// window is on. Needs you holds only the decisions core's who-owes table names a person's, and is not
// drawn while none waits. Stuck counts what the Issues list's Stuck group counts, from the same read.
// The page reads none of the retired or misplaced reads (the steward's budget, agent memory,
// onboarding, workflows, forecasts) and sends 8 calls or fewer. /memory no longer lands on it
// (routes/moved-pages.test.tsx).
//
// @direct-test-of packages/web-v2/src/routes/_workspace/projects/$slug/index.tsx
// @direct-test-of packages/web-v2/src/features/activity/dashboard/project-dashboard.tsx
// @direct-test-of packages/web-v2/src/features/releases/hooks.ts

import type { DebtLedgerView } from "@forge/contracts/cleanup";
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Call, fakeCore, HANG } from "@/test/render";
import { componentOf, renderRoute } from "@/test/route-tree";
import { STANDING_LIST } from "@/test/vi-chrome-issues";

vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));

import { Route as DashboardRoute } from "@/routes/_workspace/projects/$slug/index";

const P = "3f0c2a9e-6a51-4f7e-9d3c-0b6f1e2a7c11";
const project = { id: P, slug: "forge", name: "Forge", role: "admin", orgId: null, orgRole: null };
const AT = "2026-11-07T01:00:00.000Z";

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
const decisions = (n: number) => ({ generatedAt: AT, decisions: n ? [decision] : [], total: n, notDecisions: [] });

const release = (version: string, name: string, at: string) => ({ key: version, version, name, state: "shipped", releasedAt: at, at, issueCount: 2 });
/** `GET releases/shipped?limit=3`: the newest shipped, newest first, as core orders them (ISS-1070). */
const SHIPPED = {
  releases: [release("0.4.0-dev.552", "Clearer Activity", AT), release("0.4.0-dev.551", "Calmer rail", "2026-11-06T22:00:00.000Z")],
};
const LEDGER_ON: DebtLedgerView = {
  fast: true,
  open: [{ id: "d1", where: "issues/standing.ts", detail: "two reads of one fact" } as never],
  cleared: [],
  window: { scheduleId: "s1", cron: "0 2 * * *", timeZone: null, enabled: true, nextRunAt: "2026-11-08T02:00:00.000Z", lastRun: null },
  windowOff: null,
};

function serve(n: number | "unanswered"): Call[] {
  return fakeCore((c) => {
    const path = c.path.split("?")[0] ?? "";
    if (path === "/projects") return { body: [project] };
    if (path.endsWith("/needs-you/decisions")) return n === "unanswered" ? HANG : { body: decisions(n) };
    if (path.endsWith("/issues/standing")) return { body: STANDING_LIST };
    if (path.endsWith("/releases/shipped") && c.path.endsWith("?limit=3")) return { body: SHIPPED };
    if (path.endsWith("/debts")) return { body: LEDGER_ON };
    // anything else the page asks for is a read it should not send; answer it so the count says so
    return { body: {} };
  });
}

async function open(n: number | "unanswered" = 0) {
  const calls = serve(n);
  await renderRoute({ at: "/projects/forge", pattern: "/projects/$slug", page: componentOf(DashboardRoute, "routes/_workspace/projects/$slug/index.tsx") });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 300));
  });
  return calls;
}

const sections = () => screen.getAllByTestId("list-group").map((g) => g.getAttribute("data-group"));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("the project Dashboard (ISS-1067)", () => {
  it("draws Moving, Shipped and Stuck as one grouped list, and no Needs you while nothing waits", async () => {
    await open(0);
    await screen.findByTestId("dashboard");
    expect(sections()).toEqual(["moving", "shipped", "stuck"]);
    expect(screen.queryByText("Which login provider ships first?")).toBeNull();
  });

  it("leads with Needs you, the decisions a person owes, when one waits", async () => {
    await open(1);
    await screen.findByText("Which login provider ships first?");
    expect(sections()).toEqual(["needs", "moving", "shipped", "stuck"]);
  });

  // ISS-1070: Needs you is core's slowest read (5 s on forge-dev); the page never waits on it
  it("draws Moving, Shipped and Stuck while Needs you is still being read, saying Needs you is reading", async () => {
    await open("unanswered");
    await screen.findByTestId("dashboard");
    expect(sections()).toEqual(["moving", "shipped", "stuck"]);
    expect(screen.getByTestId("dashboard-needs-reading")).toBeTruthy();
  });

  it("counts Stuck as the Issues list's Stuck group counts it, from the same read", async () => {
    await open(0);
    const stuck = (await screen.findAllByTestId("list-group")).find((g) => g.getAttribute("data-group") === "stuck") as HTMLElement;
    const issuesStuck = STANDING_LIST.issues.filter((r) => r.standing.attentionGroup === "stuck").length;
    expect(within(stuck).getByTestId("group-count").textContent).toBe(String(issuesStuck));
  });

  it("says the cleanup window in one Audit line", async () => {
    await open(0);
    expect((await screen.findByTestId("dashboard-audit")).textContent).toMatch(/1 open debt/);
  });

  it("sends 8 calls or fewer, none to the steward's budget, memory, onboarding, workflows or forecasts", async () => {
    const calls = await open(0);
    await screen.findByTestId("dashboard");
    const paths = calls.map((c) => c.path.split("?")[0] ?? "");
    expect(paths.filter((p) => /steward-budget|\/memory\/entries|\/onboarding|\/workflows|\/workflow-templates|\/forecast\//.test(p))).toEqual([]);
    expect(paths.length).toBeLessThanOrEqual(8);
    // the newest shipped releases, never the project's whole release list (ISS-1070)
    expect(paths.filter((p) => /\/releases$/.test(p))).toEqual([]);
    expect(paths.filter((p) => p.endsWith("/releases/shipped"))).toHaveLength(1);
    expect(screen.queryByTestId("onboarding-hint")).toBeNull();
    expect(screen.queryByText(/Next release|Lands this week/)).toBeNull();
  });
});
