// The module map (ISS-1256, mockup MK-11). The Modules screen opens on the pillar: one row per business
// module, one column per branch, each count opening that module's tree at that branch, the Unplaced
// row beneath, gaps drawn and never gated, open issues the only health figure. A module's page is its
// tree beside the rail of the node it selects: the five relation kinds, each walking on, its re-check
// and its reads.
//
// @direct-test-of packages/web-v2/src/features/modules/components/module-map-screen.tsx
// @direct-test-of packages/web-v2/src/features/modules/components/module-tree-screen.tsx
// @direct-test-of packages/web-v2/src/features/modules/components/pillar-table.tsx
// @direct-test-of packages/web-v2/src/features/modules/components/node-rail.tsx
// @direct-test-of packages/web-v2/src/features/modules/pillar.ts
// @direct-test-of packages/web-v2/src/features/modules/module-tree.ts

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageCommandsProvider } from "@/design";
import { MAP_PROJECT, PILLAR, TREE } from "@/test/module-map";
import { fakeCore, renderWithQuery } from "@/test/render";
import { rawKeysOnFace } from "@/test/screen-face";
import { ModuleMapScreen } from "./module-map-screen";
import { ModuleTreeScreen } from "./module-tree-screen";

const replace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble({ useRouter: () => ({ replace }) }));

const searched = vi.fn();
const inWorkspace = (ui: ReactNode) => (
  <PageCommandsProvider openPalette={() => {}} searchPalette={searched}>
    {ui}
  </PageCommandsProvider>
);

const core = () =>
  fakeCore((c) => {
    if (c.path === `/projects/${MAP_PROJECT}/modules/map`) return { body: PILLAR };
    if (c.path === `/projects/${MAP_PROJECT}/modules/execution/map`) return { body: TREE };
    if (c.path.startsWith(`/projects/${MAP_PROJECT}/find/gaps`)) return { body: { projectId: MAP_PROJECT, window: { days: 30, since: "2026-10-17" }, gaps: [{ query: "steward budget", searches: 3, firstAt: "", lastAt: "", lastBy: "agent" }] } };
    return undefined;
  });

const at = (path: string) => window.history.replaceState(null, "", path);

beforeEach(() => {
  at("/projects/hop/modules");
  core();
});
afterEach(() => {
  replace.mockClear();
  searched.mockClear();
});

const countIn = (row: HTMLElement, branch: string) => {
  const cell = row.querySelector<HTMLAnchorElement>(`[data-testid=pillar-count][data-branch=${branch}]`);
  if (!cell) throw new Error(`no ${branch} count`);
  return cell;
};

describe("the pillar", () => {
  it("draws one row per module and one column per branch, open issues the only health figure", async () => {
    renderWithQuery(inWorkspace(<ModuleMapScreen projectId={MAP_PROJECT} slug="hop" />));
    const rows = await screen.findAllByTestId("pillar-row");
    expect(rows.map((r) => r.querySelector("a")?.textContent)).toEqual(["Execution", "Work & delivery", "Release & deploy", "Adapters"]);
    const heads = within(screen.getByTestId("pillar")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Module", "Terms", "Rules", "Capabilities", "Requirements", "Decisions", "References", "Open issues"]);
    expect(screen.queryByText(/score|health/i)).toBeNull();
  });

  it("opens each count on that module's tree at that branch", async () => {
    renderWithQuery(inWorkspace(<ModuleMapScreen projectId={MAP_PROJECT} slug="hop" />));
    const execution = (await screen.findAllByTestId("pillar-row"))[0];
    expect(countIn(execution, "rule").getAttribute("href")).toBe("/projects/hop/modules/execution?type=rule");
    expect(countIn(execution, "rule").textContent).toBe("9");
    expect(countIn(execution, "inflight").getAttribute("href")).toBe("/projects/hop/modules/execution?type=inflight");
    expect(countIn(execution, "inflight").textContent).toBe("3");
  });

  it("lists what no module holds in an Unplaced row, every count a gap and none of it refused", async () => {
    renderWithQuery(inWorkspace(<ModuleMapScreen projectId={MAP_PROJECT} slug="hop" />));
    const unplaced = await screen.findByTestId("pillar-unplaced");
    expect(unplaced.querySelector("a")?.textContent).toBe("Unplaced");
    expect(countIn(unplaced, "requirement").textContent).toBe("97");
    expect(countIn(unplaced, "requirement").getAttribute("href")).toBe("/projects/hop/modules/unplaced?type=requirement");
    expect(countIn(unplaced, "inflight").dataset.gap).toBe("true");
  });

  it("draws a module with no term as a gap, and one with no purpose says so", async () => {
    renderWithQuery(inWorkspace(<ModuleMapScreen projectId={MAP_PROJECT} slug="hop" />));
    const release = (await screen.findAllByTestId("pillar-row"))[2];
    expect(countIn(release, "term").dataset.gap).toBe("true");
    expect(countIn(release, "reference").dataset.gap).toBeUndefined();
    expect(release.textContent).toContain("No purpose");
  });

  it("stacks on a phone: each module a block of its seven counts, each named, none behind a sideways scroll", async () => {
    renderWithQuery(inWorkspace(<ModuleMapScreen projectId={MAP_PROJECT} slug="hop" />));
    const stack = await screen.findByTestId("pillar-stack");
    const blocks = within(stack).getAllByTestId("pillar-stack-row");
    expect(blocks.map((b) => b.querySelector("a")?.textContent)).toEqual(["Execution", "Work & delivery", "Release & deploy", "Adapters"]);
    const [execution] = blocks;
    expect([...execution.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Terms", "Rules", "Capabilities", "Requirements", "Decisions", "References", "Open issues"]);
    expect(countIn(execution, "rule").getAttribute("href")).toBe("/projects/hop/modules/execution?type=rule");
    expect(countIn(within(stack).getByTestId("pillar-stack-unplaced"), "requirement").textContent).toBe("97");
  });

  it("shows the searches that found nothing, each searched again on a click", async () => {
    renderWithQuery(inWorkspace(<ModuleMapScreen projectId={MAP_PROJECT} slug="hop" />));
    fireEvent.click(await screen.findByTestId("find-gap-query"));
    expect(searched).toHaveBeenCalledWith("steward budget");
  });

  it("names no slug, key or sha on its face", async () => {
    const { container } = renderWithQuery(inWorkspace(<ModuleMapScreen projectId={MAP_PROJECT} slug="hop" />));
    await screen.findAllByTestId("pillar-row");
    expect(rawKeysOnFace(container)).toEqual([]);
    expect(container.textContent).not.toMatch(/work-delivery|release-deploy/);
  });
});

describe("a module's tree and its rail", () => {
  const tree = async (path: string) => {
    at(path);
    renderWithQuery(inWorkspace(<ModuleTreeScreen projectId={MAP_PROJECT} slug="hop" moduleSlug="execution" />));
    return screen.findByTestId("node-rail");
  };

  it("opens at the branch a count named, its first node in the rail", async () => {
    const rail = await tree("/projects/hop/modules/execution?type=rule");
    expect(screen.getByTestId("tree-branch-rule").dataset.at).toBe("true");
    expect(screen.getByTestId("tree-branch-term").dataset.at).toBeUndefined();
    expect(rail.dataset.node).toBe("rule:one-slot-minimum");
  });

  it("draws the seven branches in the pillar's order", async () => {
    await tree("/projects/hop/modules/execution");
    const branches = [...screen.getByTestId("module-tree").children].map((b) => b.getAttribute("data-testid"));
    expect(branches).toEqual(["term", "rule", "capability", "requirement", "decision", "reference", "inflight"].map((b) => `tree-branch-${b}`));
  });

  it("shows a term's other names, its relations by kind, its re-check and its reads", async () => {
    const rail = await tree("/projects/hop/modules/execution?node=term:run-slots");
    expect(rail.dataset.node).toBe("term:run-slots");
    expect(within(rail).getByTestId("rail-aliases").textContent).toContain("chia slot");
    expect(within(rail).getByTestId("rail-used_in.out").textContent).toContain("A project with work keeps at least one slot");
    expect(within(rail).getByTestId("rail-from.out").textContent).toContain("Steward follows the work");
    expect(within(rail).getByTestId("rail-anchored_at.out").textContent).toContain("packages/core/src/devices/run-slots.ts:slotsFor");
    expect(within(rail).getByText("Execution › Devices")).toBeTruthy();
    expect(within(rail).getByTestId("rail-recheck").textContent).toContain("Current");
    expect(within(rail).getByTestId("rail-reads").textContent).toContain("14 in 30 days");
  });

  it("walks each relation: a node on this page selects in place, one in another module links there, a code anchor searches", async () => {
    const rail = await tree("/projects/hop/modules/execution?node=term:run-slots");
    const [rule, cap] = within(within(rail).getByTestId("rail-used_in.out")).getAllByTestId("rail-relation");
    fireEvent.click(rule);
    await waitFor(() => expect(screen.getByTestId("node-rail").dataset.node).toBe("rule:one-slot-minimum"));
    expect(new URLSearchParams(window.location.search).get("node")).toBe("rule:one-slot-minimum");
    expect(cap?.tagName).toBe("BUTTON");
    fireEvent.click(within(screen.getByTestId("rail-used_in.in")).getByTestId("rail-relation"));
    await waitFor(() => expect(screen.getByTestId("node-rail").dataset.node).toBe("term:run-slots"));
    const from = within(screen.getByTestId("rail-from.out")).getByTestId("rail-relation");
    expect(from.getAttribute("href")).toBe("/projects/hop/modules/work-delivery?type=decision&node=decision%3Ac-owner-1116");
    fireEvent.click(within(screen.getByTestId("rail-anchored_at.out")).getByTestId("rail-relation"));
    expect(searched).toHaveBeenCalledWith("packages/core/src/devices/run-slots.ts:slotsFor");
  });

  it("reads a rule owing a re-check as owed, never current", async () => {
    const rail = await tree("/projects/hop/modules/execution?node=rule:one-slot-minimum");
    expect(within(rail).getByTestId("rail-recheck").textContent).toMatch(/^Re-checkOwed since/);
  });

  it("lists on its Capabilities view the doors its tree places in the module, as the one capabilities page", async () => {
    at("/projects/hop/modules/execution?view=capabilities");
    fakeCore((c) => {
      if (c.path === `/projects/${MAP_PROJECT}/modules/execution/map`) return { body: TREE };
      if (c.path === `/projects/${MAP_PROJECT}/modules/map`) return { body: PILLAR };
      if (c.path.startsWith(`/projects/${MAP_PROJECT}/metrics/doors`))
        return {
          body: {
            projectId: MAP_PROJECT,
            window: { days: 30, since: "", until: "" },
            doors: ["run.declare", "issues.update"].map((door) => ({ door, surface: "mcp", summary: door === "run.declare" ? "Declares a run" : "Changes an issue", feature: "x", card: null, tiers: {}, twins: [], viaTwins: 0, calls: 2, refused: 0, refusedBy: {}, byAgent: {}, lastAt: null })),
            totals: { doors: 2, neverUsed: 0, calls: 4, taught: 0 },
            days: [],
            unmatched: [],
            reads: [],
            lessonsApplied: [],
            limits: [],
          },
        };
      return { status: 404, body: {} };
    });
    renderWithQuery(inWorkspace(<ModuleTreeScreen projectId={MAP_PROJECT} slug="hop" moduleSlug="execution" />));
    const doors = await screen.findAllByTestId("cap-door");
    expect(doors.map((d) => d.textContent)).toEqual([expect.stringContaining("Declares a run")]);
  });

  it("lists the Unplaced items in the same branches", async () => {
    at("/projects/hop/modules/unplaced?type=requirement");
    renderWithQuery(inWorkspace(<ModuleTreeScreen projectId={MAP_PROJECT} slug="hop" moduleSlug="unplaced" />));
    const reqs = await screen.findByTestId("tree-branch-requirement");
    expect(reqs.dataset.at).toBe("true");
    expect(within(reqs).getByTestId("tree-node").getAttribute("href")).toBe("/projects/hop/requirements/REQ-12");
    expect(within(reqs).getByText("96 more")).toBeTruthy();
  });
});
