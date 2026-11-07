// The sidebar's one nav model (simplify census C2-10): the workspace tier carries the attention count
// and one Ecosystem row, the project tier its needs-you counts, and the one switcher both rail widths
// open lists pinned projects first. A row a person never acts on has none (ISS-1071, ISS-1073):
// Approvals is read under the Dashboard's Needs you, Threads from the Ecosystem page while a thread
// exists, Pair on Runners, and Pipeline as Issues › Waves.

import { say } from "@/test/said";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isNavGroup } from "@/design";
import { type SwitcherProject, ProjectSwitcher, switcherRows } from "./components/project-switcher";
import { buildWorkspaceCommands } from "./commands";
import { PROJECT_ITEMS, buildActiveKey, buildBottomActiveKey, projectMenu, workspaceNavItems } from "./nav-model";

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
  it("puts the attention count on Overview and ends the workspace tier with one Ecosystem row, its count what waits on the person", () => {
    const items = workspaceNavItems(7, undefined);
    expect(items.map((e) => e.key)).toEqual(["overview", "activity", "runners", "integrations", "ecosystem"]);
    expect(items[0]).toMatchObject({ badge: 7 });
    const eco = items[4];
    expect(isNavGroup(eco)).toBe(false);
    expect(eco).toMatchObject({ key: "ecosystem", label: "Ecosystem", href: "/ecosystems" });
    expect(eco?.badge).toBeUndefined();
    const read = { mine: ["p1"], drafts: [], ecosystems: [], invitations: [], projects: [], threads: [] } as never;
    expect(workspaceNavItems(0, read)[4]).toMatchObject({ key: "ecosystem", badge: 0 });
  });

  it("lights the one Ecosystem row on every ecosystem page, Runners on Pair, and Issues on the old Pipeline", () => {
    for (const path of ["/ecosystems", "/ecosystems/threads", "/ecosystems/new", "/ecosystems/e1/contracts"]) expect(buildActiveKey(path, null)).toBe("ecosystem");
    expect(buildActiveKey("/pair", null)).toBe("runners");
    expect(buildActiveKey("/projects/hop/pipeline", "hop")).toBe("proj-issues");
  });

  it("groups the product record under Product, open, and the build machinery under Delivery (REQ-34 BC-23)", () => {
    const menu = projectMenu({});
    expect(menu.map((e) => e.label)).toEqual(["Dashboard", "Product", "Delivery"]);
    const groups = menu.filter(isNavGroup);
    expect(groups.map((g) => [g.key, g.defaultOpen])).toEqual([
      ["product", true],
      ["delivery", undefined],
    ]);
    const product = groups[0]?.items.map((it) => it.label) ?? [];
    // REQ-33 BC-8, BC-9: a question is read in Approvals and on its item, a lesson is internal to Forge; neither has a page
    expect([...product].sort()).toEqual(["Channels", "Feedback", "Releases", "Requirements", "Workflows"]);
    // a person works in Feedback, Requirements and Releases, so Product leads with those three (ISS-1001)
    expect(product.slice(0, 3)).toEqual(["Feedback", "Requirements", "Releases"]);
    expect(PROJECT_ITEMS.map((it) => it.sub)).not.toEqual(expect.arrayContaining(["/questions"]));
    expect(PROJECT_ITEMS.map((it) => it.sub)).not.toEqual(expect.arrayContaining(["/lessons"]));
    expect(groups[1]?.items.map((it) => it.label)).toEqual(["Overview", "Issues", "Modules", "Agents / Runs", "Contracts", "Automation"]);
    expect(PROJECT_ITEMS.map((it) => it.label)).not.toContain("Development");
  });

  it("badges a grouped row from the needs-you read, and never Issues, which waits on no person (REQ-68 BC-6)", () => {
    const needsYou = { areas: { contracts: { you: 2, total: 2, acts: [] } } } as never;
    const delivery = projectMenu({ needsYou }).filter(isNavGroup).find((g) => g.key === "delivery");
    expect(delivery?.items.find((it) => it.key === "proj-contracts")).toMatchObject({ badge: 2 });
    expect(delivery?.items.find((it) => it.key === "proj-issues")?.badge).toBeUndefined();
    expect(delivery?.items.find((it) => it.key === "proj-modules")?.badge).toBeUndefined();
  });

  it("holds no Approvals row: the serious decisions are read under the Dashboard's Needs you, which its page lights (ISS-1071)", () => {
    expect(PROJECT_ITEMS.map((it) => it.key)).not.toContain("proj-approvals");
    expect(projectMenu({}).map((e) => e.key)).not.toContain("proj-approvals");
    expect(buildActiveKey("/projects/hop/approvals", "hop")).toBe("proj-overview");
  });

  it("lights a Product row on its own page", () => {
    expect(buildActiveKey("/projects/hop/requirements/REQ-3", "hop")).toBe("proj-requirements");
    expect(buildActiveKey("/projects/hop/feedback", "hop")).toBe("proj-feedback");
    expect(buildActiveKey("/projects/hop/channels/GROUP1", "hop")).toBe("proj-channels");
  });

  it("holds no Decisions, Roadmap or Memory entry: each is read on the item it is about (REQ-33 BC-1)", () => {
    for (const sub of ["/decisions", "/roadmap", "/memory"]) expect(PROJECT_ITEMS.map((it) => it.sub)).not.toContain(sub);
    for (const key of ["proj-decisions", "proj-roadmap", "proj-memory"]) expect(PROJECT_ITEMS.map((it) => it.key)).not.toContain(key);
    expect(buildActiveKey("/projects/hop/memory", "hop")).toBe("proj-overview");
    const palette = buildWorkspaceCommands({ router: { push: vi.fn() }, slug: "hop", onNewChat: vi.fn(), activeProjectName: "HOP", scopedProjects: [], pinnedIds: new Set(), pinnedViews: [], recents: [], toast: vi.fn() });
    expect(palette.map((c) => c.label).filter((l) => /^HOP · (Decisions|Roadmap|Memory)$/.test(l))).toEqual([]);
    expect(palette.map((c) => c.label)).toContain("HOP · Requirements");
  });

  it("badges Workflows with the same designs rows the Dashboard draws", () => {
    const needsYou = { areas: { designs: { you: 1, acts: [{ act: "approve or return the design", count: 1, says: { act: say("designs.act.approveOrReturn") } }] } } } as never;
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

describe("the phone tab bar's lit tab", () => {
  it("lights Attention on a project's Approvals, the decisions its badge counts, and on Attention itself", () => {
    expect(buildBottomActiveKey("/projects/forge/approvals", false, false)).toBe("attention");
    expect(buildBottomActiveKey("/projects/forge/approvals/", false, false)).toBe("attention");
    expect(buildBottomActiveKey("/attention", false, false)).toBe("attention");
  });

  it("lights Home on every other page, and More or Ask Agent while its sheet is open", () => {
    expect(buildBottomActiveKey("/projects/forge", false, false)).toBe("home");
    expect(buildBottomActiveKey("/projects/forge/approvals-log", false, false)).toBe("home");
    expect(buildBottomActiveKey("/projects/forge/issues", false, false)).toBe("home");
    expect(buildBottomActiveKey("/projects/forge/approvals", true, false)).toBe("more");
    expect(buildBottomActiveKey("/projects/forge/approvals", false, true)).toBe("chat");
  });
});
