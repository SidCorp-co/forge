// @vitest-environment jsdom
//
// ISS-1156 — the four places the workspace Attention badge is drawn name a read that is on its way
// and a read that failed in their own mark and accessible name; only a read zero draws nothing.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavRailCompact, type RailItem } from "@/features/shell/nav-rail-compact";
import { MobileNavDrawer } from "@/features/shell/components/mobile-nav-drawer";
import type { BadgeFigure } from "./badge-read";
import { BottomTabBar } from "./bottom-tab-bar";
import { NavRail } from "./nav-rail";

vi.mock("@/features/orgs/components/org-switcher", () => ({ OrgSwitcher: () => null }));

afterEach(cleanup);

const STATES: Array<[string, BadgeFigure, RegExp]> = [
  ["a read count", { badge: 20 }, /20 need attention/],
  ["a read on its way", { badgeRead: "pending" }, /reading how many need attention/],
  ["a read that failed", { badgeRead: "failed" }, /how many need attention could not be read/],
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
