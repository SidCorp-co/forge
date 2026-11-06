// ISS-1051: a project's Activity peek shows its release run in flight (cut, deploying or shipped) in
// place of the next release, and its cleanup on one compact row: whether its window is on and its next
// run, its last report (what it cleared and what remains, opened on demand) and its open debt,
// counted and opened on demand. Debt is named by where it is, never by an id; why a window is off is
// the row's tooltip.
//
// @direct-test-of packages/web-v2/src/features/activity/components/cleanup.tsx
// @direct-test-of packages/web-v2/src/features/activity/components/activity-peek.tsx
// @direct-test-of packages/web-v2/src/features/activity/hooks.ts
// @direct-test-of packages/web-v2/src/features/activity/api.ts

import type { CleanupReportView, DebtLedgerView, DebtView } from "@forge/contracts/cleanup";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ago, LEDGER_NONE, ORG, project, read, serve } from "@/test/activity.fixture";
import { renderWithQuery } from "@/test/render";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: ORG }) }));

import { ActivityScreen } from "./activity-screen";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const DEBT_IDS = ["7c1d0a4e-0000-4000-8000-000000000001", "7c1d0a4e-0000-4000-8000-000000000002", "7c1d0a4e-0000-4000-8000-000000000003"] as const;
const debt = (id: string, where: string, cleared: boolean): DebtView => ({
  id,
  issueId: null,
  issueKey: null,
  kind: "debt",
  check: null,
  where,
  detail: `Left behind in ${where}`,
  impact: { type: "logic", rating: "low", reason: "contained" },
  recordedBy: null,
  recordedAt: ago(90_000),
  cleared: cleared ? { reportId: "r-1", how: "split the module", at: ago(54_000) } : null,
  carried: null,
  evidence: [],
});
const LEDGER_ON: DebtLedgerView = {
  fast: true,
  open: [debt(DEBT_IDS[1], "src/orders/export.ts", false), debt(DEBT_IDS[2], "src/catalog/sync.ts", false)],
  cleared: [debt(DEBT_IDS[0], "src/auth/session.ts", true)],
  window: { scheduleId: "sch-1", cron: "0 18 * * *", timeZone: null, enabled: true, nextRunAt: new Date(Date.now() + 3_600_000).toISOString() },
  windowOff: null,
};
const REPORT: CleanupReportView = {
  id: "r-1",
  fireId: null,
  base: { branch: "dev", sha: "a".repeat(40) },
  result: "red",
  ci: null,
  cleared: [{ debt: DEBT_IDS[0], how: "split the module" }],
  remains: [
    { debt: DEBT_IDS[1], why: "needs the export rewrite" },
    { debt: DEBT_IDS[2], why: "waits on the sync contract" },
  ],
  reportedBy: null,
  reportedAt: ago(54_000),
  supersededBy: null,
};

const API = project({ projectId: "p-api", slug: "api-slug", name: "AdminHub API", standing: "working", releasing: { version: "0.14.0", stage: "deploying", since: ago(600) } });
const FE = project({ projectId: "p-fe", slug: "fe-slug", name: "AdminHub FE", standing: "idle", release: { key: "REQ-9", title: "Bulk edit", shipped: 1, awaitingRelease: 0, total: 3 } });

const peekOf = async (name: string) => {
  const row = (await screen.findAllByTestId("list-row")).find((r) => within(r).queryByTestId("activity-name")?.textContent === name);
  if (!row) throw new Error(`no row for ${name}`);
  fireEvent.click(within(row).getByTestId("activity-name"));
  return screen.findByTestId("activity-peek");
};

describe("ISS-1051 the Activity peek shows a release in flight and the project's cleanup", () => {
  it("a release run deploying shows by its version and stage, in place of the next release", async () => {
    serve(read([API, FE]), { "p-api": { ledger: LEDGER_ON, reports: [REPORT] } });
    renderWithQuery(<ActivityScreen />);
    const peek = await peekOf("AdminHub API");
    const releasing = within(peek).getByTestId("activity-releasing");
    expect(releasing.textContent).toContain("0.14.0");
    expect(releasing.textContent).toContain("Deploying");
    expect(within(peek).queryByTestId("activity-release")).toBeNull();
  });

  it("a project with no run in flight shows its next release as before", async () => {
    serve(read([API, FE]));
    renderWithQuery(<ActivityScreen />);
    const peek = await peekOf("AdminHub FE");
    expect(within(peek).queryByTestId("activity-releasing")).toBeNull();
    expect(within(peek).getByTestId("activity-release").textContent).toContain("Bulk edit");
  });

  it("a window on shows On, its next run, the last report and the open debt counted, details folded", async () => {
    serve(read([API, FE]), { "p-api": { ledger: LEDGER_ON, reports: [REPORT] } });
    renderWithQuery(<ActivityScreen />);
    const peek = await peekOf("AdminHub API");
    const row = await within(peek).findByTestId("cleanup-window");
    expect(row.dataset.on).toBe("true");
    expect(row.textContent).toMatch(/^On\d{2}:\d{2}$/);
    const report = within(peek).getByTestId("cleanup-report");
    expect(report.textContent).toContain("Red");
    expect((report as HTMLDetailsElement).open, "the last report is opened without asking").toBe(false);
    const debts = within(peek).getByTestId("cleanup-debts");
    expect(within(debts).getByText("2")).toBeTruthy();
    expect((debts as HTMLDetailsElement).open).toBe(false);
    // opened, the report names what it cleared and what remains by where, why on hover
    fireEvent.click(within(report).getByText("Last report"));
    await waitFor(() => expect((report as HTMLDetailsElement).open).toBe(true));
    expect(report.textContent).toContain("src/auth/session.ts");
    expect(report.textContent).toContain("src/orders/export.ts");
    expect(report.textContent).toContain("src/catalog/sync.ts");
    expect(peek.textContent, "a debt id was shown as text").not.toMatch(/7c1d0a4e/);
  });

  it("a window off reads Off with why on hover, and a project never reported says so", async () => {
    serve(read([API, FE]));
    renderWithQuery(<ActivityScreen />);
    const peek = await peekOf("AdminHub FE");
    const row = await within(peek).findByTestId("cleanup-window");
    expect(row.dataset.on).toBe("false");
    expect(row.textContent).toBe("Off");
    expect(row.getAttribute("title")).toBe(LEDGER_NONE.windowOff);
    expect(within(peek).getByTestId("cleanup-no-report").textContent).toBe("No report");
    expect(within(peek).queryByTestId("cleanup-debts")).toBeNull();
  });
});
