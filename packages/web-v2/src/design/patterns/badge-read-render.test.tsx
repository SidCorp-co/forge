// @vitest-environment jsdom
//
// ISS-1156 — the four places the workspace Attention badge is drawn name a read that is on its way
// and a read that failed in their own mark and accessible name; only a read zero draws nothing.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavRailCompact, type RailItem } from "@/features/shell/nav-rail-compact";
import { MobileNavDrawer } from "@/features/shell/components/mobile-nav-drawer";
import { bottomTabItems, compactWorkspaceRailItems, projectRailItems } from "@/features/shell/nav-model";
import { ATTENTION_COUNTS, type BadgeFigure } from "./badge-read";
import { BottomTabBar } from "./bottom-tab-bar";
import { NavRail } from "./nav-rail";

vi.mock("@/features/orgs/components/org-switcher", () => ({ OrgSwitcher: () => null }));

afterEach(cleanup);

const STATES: Array<[string, BadgeFigure, RegExp]> = [
  ["a read count", { badge: 20, badgeCounts: ATTENTION_COUNTS }, /20 need attention/],
  ["a read on its way", { badgeRead: "pending", badgeCounts: ATTENTION_COUNTS }, /reading how many need attention/],
  ["a read that failed", { badgeRead: "failed", badgeCounts: ATTENTION_COUNTS }, /how many need attention could not be read/],
];

describe("the Attention badge, drawn", () => {
  it.each(STATES)("the bottom bar names %s", (_n, figure, name) => {
    render(<BottomTabBar items={[{ key: "attention", label: "Attention", icon: "inbox", ...figure }]} activeKey="" onSelect={() => {}} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(name);
  });

  it.each(STATES)("the expanded rail names %s", (_n, figure, name) => {
    render(<NavRail workspaceItems={[{ key: "overview", label: "Overview", icon: "grid", ...figure }]} activeKey="" />);
    expect(screen.getByRole("button", { name: figure.badgeRead ? name : /Overview\s*20/ })).toBeTruthy();
  });

  it.each(STATES)("the collapsed rail names %s", (_n, figure, name) => {
    render(<NavRail collapsed workspaceItems={[{ key: "overview", label: "Overview", icon: "grid", ...figure }]} activeKey="" />);
    expect(screen.getByRole("button", { name })).toBeTruthy();
  });

  it.each(STATES)("the compact rail names %s", (_n, figure, name) => {
    const items: RailItem[] = [{ key: "overview", label: "Overview", icon: "grid", ...figure }];
    render(
      <NavRailCompact
        workspaceItems={items}
                activeKey=""
        activeSlug={null}
                switcherProjects={[]}
        onNavigate={() => {}}
        onSelectProject={() => {}}
        onTogglePin={() => {}}
        onAllProjects={() => {}}
        onNewProject={() => {}}
        onAccount={() => {}}
        onWhatsNew={() => {}}
        onDocs={() => {}}
        onExpand={() => {}}
        userInitials="FO"
      />,
    );
    expect(screen.getByRole("button", { name: /Overview/ }).getAttribute("aria-label")).toMatch(name);
  });

  it.each(STATES)("the mobile drawer names %s", (_n, figure, name) => {
    render(
      <MobileNavDrawer
        open
        onClose={() => {}}
        slug={null}
        railSlug={null}
        railProjectName={null}
        activeKey=""
        attention={figure}
        openIssuesBadge={undefined}
        scopedProjects={[]}
        onNavigate={() => {}}
        onOpenProject={() => {}}
        onCreateProject={() => {}}
        onViewAllProjects={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: figure.badgeRead ? name : /Attention\s*20/ })).toBeTruthy();
  });

  it("draws nothing for a read zero, on the bottom bar", () => {
    render(<BottomTabBar items={[{ key: "attention", label: "Attention", icon: "inbox", badge: 0 }]} activeKey="" onSelect={() => {}} />);
    const b = screen.getByRole("button");
    expect(b.getAttribute("aria-label")).toBe("Attention");
    expect(b.textContent).toBe("Attention");
  });
});

// The Issues row's figure is open work (29), not the attention figure (10) the Overview row beside it
// carries. Rows come from the nav model, as the layout builds them, so a surface that names the Issues
// figure with the attention words goes red here by name.
describe("the Issues badge, drawn beside the Attention one", () => {
  const attention: BadgeFigure = { badge: 10, badgeCounts: ATTENTION_COUNTS };
  const nameOf = (el: HTMLElement) => `${el.getAttribute("aria-label") ?? ""} | ${el.getAttribute("title") ?? ""} | ${el.textContent ?? ""}`;

  it("the compact rail names Issues by open work, in its name and its tooltip, and Overview by attention", () => {
    render(
      <NavRailCompact
        workspaceItems={compactWorkspaceRailItems(attention)}
        projectItems={projectRailItems(29)}
        activeKey="proj-issues"
        activeSlug="sable"
        activeProject={{ name: "Sable", initials: "SA", tint: "#eee", ink: "#111", liveRuns: 0 }}
        switcherProjects={[]}
        onNavigate={() => {}}
        onSelectProject={() => {}}
        onTogglePin={() => {}}
        onAllProjects={() => {}}
        onNewProject={() => {}}
      />,
    );
    const issues = screen.getByRole("button", { name: /^Issues/ });
    expect(issues.getAttribute("aria-label")).toBe("Issues, 29 in open work");
    expect(issues.getAttribute("title")).toBe("Issues, 29 in open work");
    expect(screen.getByRole("button", { name: /^Overview/ }).getAttribute("aria-label")).toBe("Overview, 10 need attention");
    for (const b of screen.getAllByRole("button")) {
      if (!/^Overview/.test(b.getAttribute("aria-label") ?? "")) expect(nameOf(b)).not.toMatch(/need attention|need you/);
    }
  });

  it("the bottom bar names Issues by open work and Attention by attention", () => {
    render(<BottomTabBar items={bottomTabItems("sable", attention, 29)} activeKey="proj-issues" onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /^Issues/ }).getAttribute("aria-label")).toBe("Issues, 29 in open work");
    for (const b of screen.getAllByRole("button")) expect(nameOf(b)).not.toMatch(/need attention|need you/);
  });

  it("the mobile drawer names Issues without the attention words and Attention with them", () => {
    render(
      <MobileNavDrawer
        open
        onClose={() => {}}
        slug="sable"
        railSlug="sable"
        railProjectName="Sable"
        activeKey="proj-issues"
        attention={attention}
        openIssuesBadge={29}
        scopedProjects={[]}
        onNavigate={() => {}}
        onOpenProject={() => {}}
        onCreateProject={() => {}}
        onViewAllProjects={() => {}}
      />,
    );
    expect(nameOf(screen.getByRole("button", { name: /^Issues/ }))).not.toMatch(/need attention|need you/);
    expect(screen.getByRole("button", { name: /^Issues/ }).textContent).toMatch(/29/);
    expect(screen.getByRole("button", { name: /^Attention/ }).textContent).toMatch(/10/);
  });

  it("an Issues figure with nothing said about what it counts claims nothing", () => {
    render(<BottomTabBar items={[{ key: "proj-issues", label: "Issues", icon: "list", badge: 29 }]} activeKey="" onSelect={() => {}} />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Issues, 29");
  });
});
