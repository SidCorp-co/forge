// Projects and a project's Dashboard read attention one way (ISS-1072 round 3). On forge-dev,
// 2026-11-07, Projects read agenfold "Attention" while its Dashboard showed nothing needing it: the
// Projects page counted any issue parked at needs_info or on_hold (`projects/derive.ts:deriveHealth`
// over the health rollup's `blockers`), the Dashboard draws Needs you and Stuck from the issue
// standing and the decisions waiting on the reader. Projects now reads its Attention through the
// Dashboard's own reading (`project-dashboard.tsx:needsAttention`).
// @direct-test-of packages/web-v2/src/features/projects/derive.ts
// @direct-test-of packages/web-v2/src/routes/_workspace/projects/index.tsx

import type { IssueStandingRow } from "@forge/contracts/issue-standing";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProjectsAttention } from "@/features/activity";
import { deriveHealth } from "@/features/projects";
import { ProjectsConsole } from "@/features/projects/components/projects-console";
import { STANDING_ROWS } from "@/test/vi-chrome-issues";
import { Seeded } from "@/test/vi-chrome-requirements";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/orgs", async (orig) => ({
  ...(await orig<typeof import("@/features/orgs")>()),
  useActiveOrg: () => ({ orgs: [], activeOrg: { id: "o1", name: "SidCorp", isPersonal: false }, activeOrgId: "o1", setActiveOrg: () => {}, isSingle: false, resolved: true }),
}));

afterEach(cleanup);

const AGENFOLD = "p-agenfold";
const FORGE = "p-forge";
/** An issue held on_hold, as agenfold's one active issue was: paused, its master to resume it, never stuck. */
const held = STANDING_ROWS.find((r) => r.status === "on_hold") as IssueStandingRow;
const stuck = STANDING_ROWS.find((r) => r.standing.attentionGroup === "stuck") as IssueStandingRow;
const standing = (rows: IssueStandingRow[]) => ({ issues: rows, counts: { open: rows.length, closed: 0, all: rows.length, blocked: 0, blocking: 0 }, returned: rows.length, limit: 200, releaseApproval: false });
const noDecisions = { generatedAt: "2026-11-07T00:00:00.000Z", decisions: [], total: 0, notDecisions: [] };
const project = (id: string, name: string) => ({ id, slug: name.toLowerCase(), name, orgId: "o1", orgName: "SidCorp", orgIsPersonal: false, role: "admin", orgRole: "owner", createdAt: "2026-10-01T00:00:00.000Z" });
const health = (id: string, name: string) => ({ id, projectName: name, projectSlug: name.toLowerCase(), throughput: 0, totalActive: 1, statusDistribution: { on_hold: 1 }, blockers: [{ issueId: "ISS-9", documentId: "i9", status: "on_hold" }], pendingEscalations: 0, avgCycleTimeDays: 0, liveRuns: 0, runnerCount: 1, spend24hUsd: 0, memberCount: 1, members: [], lastActivityAt: null });

const SEED: [readonly unknown[], unknown][] = [
  [["projects"], [project(AGENFOLD, "Agenfold"), project(FORGE, "Forge")]],
  [["projects", "health"], [health(AGENFOLD, "Agenfold"), health(FORGE, "Forge")]],
  [["issues", "standing", AGENFOLD, "open"], standing([held])],
  [["issues", "standing", FORGE, "open"], standing([stuck])],
  [["needs-you", AGENFOLD, "decisions"], noDecisions],
  [["needs-you", FORGE, "decisions"], noDecisions],
];

function Page() {
  const attention = useProjectsAttention([AGENFOLD, FORGE]);
  return <ProjectsConsole attention={attention} />;
}
const mount = (ui: ReactNode) => render(<Seeded data={SEED as never}>{ui}</Seeded>);

describe("a project's attention", () => {
  it("is never read from a parked issue alone: agenfold's health row, one issue on_hold, reads no attention", () => {
    expect(deriveHealth(health(AGENFOLD, "Agenfold"))).not.toBe("attention");
  });

  it("reads on Projects as its Dashboard reads it: Forge's stuck issue needs attention, agenfold's held one does not", async () => {
    mount(<Page />);
    await waitFor(() => expect(screen.getByText("1 need attention")).toBeInTheDocument());
    const rowOf = (name: string) => screen.getAllByRole("row").find((r) => r.textContent?.includes(name)) as HTMLElement;
    expect(rowOf("Forge")).toHaveTextContent("Attention");
    expect(rowOf("Agenfold")).not.toHaveTextContent("Attention");
  });
});
