// The sidebar's one nav model (simplify census C2-10): the workspace tier carries the attention count
// and the Ecosystem group, the project tier its needs-you counts, and the one switcher both rail
// widths open lists pinned projects first.

import { say } from "@/test/said";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isNavGroup } from "@/design";
import { type SwitcherProject, ProjectSwitcher, switcherRows } from "./components/project-switcher";
import { projectMenu, workspaceNavItems } from "./nav-model";

const project = (over: Partial<SwitcherProject>): SwitcherProject => ({
  id: "p1",
  slug: "alpha",
  name: "Alpha",
  initials: "AL",
  tint: "#eee",
  ink: "#111",
  liveRuns: 0,
  pinned: false,
  ...over,
});

describe("the nav model", () => {
  it("puts the attention count on Overview and ends the workspace tier with the Ecosystem group, open by default", () => {
    const items = workspaceNavItems(7, undefined);
    expect(items.map((e) => e.key)).toEqual(["overview", "runners", "integrations", "ecosystem"]);
    expect(items[0]).toMatchObject({ badge: 7 });
    const eco = items[3];
    expect(isNavGroup(eco) && eco.defaultOpen).toBe(true);
    expect(isNavGroup(eco) && eco.items.map((it) => it.key)).toEqual(["eco-threads", "eco-new"]);
  });

  it("folds the build machinery under Development and badges its rows from the needs-you read", () => {
    const needsYou = { areas: { issues: { you: 2, total: 2, acts: [] } } } as never;
    const dev = projectMenu({ needsYou }).find(isNavGroup);
    expect(dev?.key).toBe("development");
    expect(dev?.defaultOpen).toBeUndefined();
    expect(dev?.items.find((it) => it.key === "proj-issues")).toMatchObject({ badge: 2 });
    expect(dev?.items.find((it) => it.key === "proj-modules")?.badge).toBeUndefined();
  });

  it("badges Workflows with the same designs rows the Dashboard draws", () => {
    const needsYou = { areas: { designs: { you: 1, acts: [{ act: "approve or return revision 3", count: 1, says: { act: say("designs.act.approveOrReturn", { r: 3 }) } }] } } } as never;
    const wf = projectMenu({ needsYou }).flatMap((e) => (isNavGroup(e) ? e.items : [e])).find((it) => it.key === "proj-workflows");
    expect(wf).toMatchObject({ badge: 1 });
  });
});

describe("the project switcher", () => {
  it("lists pinned projects first, then by name, and finds a project by its slug", () => {
    const list = [project({ id: "b", name: "Beta", slug: "beta" }), project({ id: "z", name: "Zed", slug: "zed", pinned: true }), project({ id: "a" })];
    expect(switcherRows(list, "").map((p) => p.name)).toEqual(["Zed", "Alpha", "Beta"]);
    expect(switcherRows(list, "BET").map((p) => p.id)).toEqual(["b"]);
  });

  const props = {
    projects: [] as SwitcherProject[],
    activeSlug: null,
    onSelect: vi.fn(),
    onSettings: vi.fn(),
    onTogglePin: vi.fn(),
    onAllProjects: vi.fn(),
    onNewProject: vi.fn(),
  };

  it.each([true, false])("offers to add a project when the org has none (compact %s)", (compact) => {
    const onNewProject = vi.fn();
    render(<ProjectSwitcher {...props} compact={compact} project={null} onNewProject={onNewProject} />);
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(onNewProject).toHaveBeenCalledOnce();
  });

  it("draws nothing without a rail project while the org still has projects", () => {
    const { container } = render(<ProjectSwitcher {...props} compact project={null} projects={[project({})]} />);
    expect(container.innerHTML).toBe("");
  });

  it("opens the list beside the rail and selects a project from it", async () => {
    const onSelect = vi.fn();
    render(
      <ProjectSwitcher
        {...props}
        compact={false}
        project={{ name: "Alpha", initials: "AL", tint: "#eee", ink: "#111", liveRuns: 2 }}
        projects={[project({}), project({ id: "b", name: "Beta", slug: "beta" })]}
        activeSlug="alpha"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole("button", { name: /Switch project/ }).textContent).toContain("2 live");
    fireEvent.click(screen.getByRole("button", { name: /Switch project/ }));
    const beta = (await screen.findByText("Beta")).closest("button");
    fireEvent.click(beta as HTMLButtonElement);
    expect(onSelect).toHaveBeenCalledWith("beta");
  });
});
