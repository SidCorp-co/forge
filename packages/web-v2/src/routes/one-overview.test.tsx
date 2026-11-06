// ISS-1069: Activity is the one cross-project screen. Ops and Home's Figures tab are gone, and a link
// kept to either lands on Activity. Home keeps only what Activity does not show, what the person asked
// for, and reads nothing Activity already reads. The live-run count is one read, the projects health
// rollup, so the rail, Activity, Projects and Agents say the same number. No Spend figure is drawn
// while every cost core holds is $0.
//
// @direct-test-of packages/web-v2/src/routes/_workspace/ops/index.tsx
// @direct-test-of packages/web-v2/src/features/overview/components/home-screen.tsx
// @direct-test-of packages/web-v2/src/features/projects/hooks.ts
// @direct-test-of packages/web-v2/src/features/projects/derive.ts
// @direct-test-of packages/web-v2/src/features/activity/components/lanes.tsx

import type { HomeResponse } from "@forge/contracts/owner-home";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FORGE, ORG, read } from "@/test/activity.fixture";
import { fakeCore, renderWithQuery } from "@/test/render";
import { componentOf } from "@/test/route-tree";

const replace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigation/router", async () =>
  (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ push: vi.fn(), replace }) }),
);
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => undefined }));
vi.mock("@/features/orgs", () => ({ useActiveOrg: () => ({ activeOrgId: ORG }) }));

import { ActivityScreen } from "@/features/activity";
import { HomeScreen } from "@/features/overview";
import { showSpend } from "@/features/projects";
import { Route as OpsRoute } from "@/routes/_workspace/ops/index";

const HOME: HomeResponse = { moving: [], movingTotal: 0, movingTruncated: false, live: [] } as unknown as HomeResponse;
const HEALTH = [{ id: "p-forge", liveRuns: 3, spend24hUsd: 0 }];

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(() => {
  cleanup();
  replace.mockClear();
  vi.unstubAllGlobals();
});

describe("one overview (ISS-1069)", () => {
  it("sends a kept /ops link to Activity", () => {
    const OpsPage = componentOf(OpsRoute, "routes/_workspace/ops/index.tsx");
    renderWithQuery(<OpsPage />);
    expect(replace).toHaveBeenCalledWith("/activity");
  });

  it("sends Home's old Figures tab to Activity", () => {
    fakeCore((c) => (c.path.startsWith("/me/home") ? { body: HOME } : { body: {} }));
    window.history.replaceState(null, "", "/?tab=figures");
    renderWithQuery(<HomeScreen />);
    expect(replace).toHaveBeenCalledWith("/activity");
  });

  it("keeps on Home only what the person asked for, and reads nothing Activity reads", async () => {
    const calls = fakeCore((c) => (c.path.startsWith("/me/home") ? { body: HOME } : { body: {} }));
    renderWithQuery(<HomeScreen />);
    await screen.findByTestId("home-moving");
    expect(screen.queryByTestId("home-waiting")).toBeNull();
    expect(screen.queryByTestId("home-live")).toBeNull();
    expect(screen.queryByRole("tab", { name: /figures/i })).toBeNull();
    expect(calls.map((c) => c.path.split("?")[0])).toEqual(["/me/home"]);
  });

  it("counts a project's live runs on Activity from the health rollup the rail and Projects read", async () => {
    fakeCore((c) => {
      if (c.path === `/orgs/${ORG}/activity`) return { body: read([FORGE]) };
      if (c.path === "/projects/health") return { body: HEALTH };
      return undefined;
    });
    renderWithQuery(<ActivityScreen />);
    const name = await screen.findByText("Forge");
    const row = name.closest("[data-testid='list-row']") as HTMLElement;
    await waitFor(() => expect(within(row).getByTestId("activity-live-runs")).toHaveTextContent("3 live"));
  });

  it("draws no Spend figure while every cost is $0", () => {
    expect(showSpend([{ spend24hUsd: 0 }, { spend24hUsd: 0 }])).toBe(false);
    expect(showSpend([{ spend24hUsd: 0 }, { spend24hUsd: 0.4 }])).toBe(true);
  });
});
