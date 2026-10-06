// One rail draws the navigation at both widths from one entry list (simplify census C2-10): the compact
// and the labelled rail list the same destinations, open the same groups, and fold the same counts.

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type NavEntry, NavRail } from "./nav-rail";

const WORKSPACE: NavEntry[] = [
  { key: "overview", label: "Overview", icon: "grid", badge: 4 },
  { key: "runners", label: "Runners", icon: "server" },
  {
    key: "ecosystem",
    label: "Ecosystem",
    icon: "ecosystem",
    defaultOpen: true,
    badge: 1,
    items: [
      { key: "eco-threads", label: "Threads", icon: "mail", badge: 1 },
      { key: "eco:e1", label: "Acme", icon: "ecosystem", mark: "AC" },
    ],
  },
];

const PROJECT: NavEntry[] = [
  { key: "proj-overview", label: "Dashboard", icon: "grid" },
  {
    key: "development",
    label: "Development",
    icon: "code",
    items: [
      { key: "proj-issues", label: "Issues", icon: "list", badge: 3, badgeHint: "Issues · waiting on you 3" },
      { key: "proj-contracts", label: "Contracts", icon: "link", badge: 2 },
    ],
  },
];

function rail(compact: boolean, over: Partial<React.ComponentProps<typeof NavRail>> = {}) {
  return render(
    <NavRail compact={compact} workspaceItems={WORKSPACE} projectItems={PROJECT} activeKey="runners" {...over} />,
  );
}

const nav = () => screen.getByRole("navigation");
const button = (name: string | RegExp) => within(nav()).getByRole("button", { name });

describe.each([
  ["compact", true],
  ["labelled", false],
])("the %s rail", (_name, compact) => {
  it("lists every top-level destination and marks the current one", () => {
    rail(compact);
    for (const name of ["Overview", "Runners", "Dashboard"]) expect(button(new RegExp(`^${name}`))).toBeTruthy();
    expect(button(/^Runners/).getAttribute("aria-current")).toBe("page");
    expect(button(/^Overview/).getAttribute("aria-current")).toBeNull();
  });

  it("opens a default-open group, keeps a default-closed one shut, and folds its rows' counts onto its head", () => {
    rail(compact);
    expect(button(/^Threads/)).toBeTruthy();
    expect(within(nav()).queryByRole("button", { name: /^Issues/ })).toBeNull();
    const head = within(screen.getByTestId("rail-group-development")).getAllByRole("button")[0];
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(head.textContent).toContain("5");
  });

  it("opens a group that holds the current page even when the reader closed it", () => {
    rail(compact, { activeKey: "proj-issues", groupOpen: { development: false } });
    const issues = button(/Issues/);
    expect(issues.getAttribute("aria-current")).toBe("page");
    const head = within(screen.getByTestId("rail-group-development")).getAllByRole("button")[0];
    expect(head.textContent).not.toContain("5");
  });

  it("an explicit group badge wins over the folded sum", () => {
    rail(compact, { groupOpen: { ecosystem: false } });
    const head = within(screen.getByTestId("rail-group-ecosystem")).getAllByRole("button")[0];
    expect(head.textContent).toContain("1");
  });

  it("toggles a group to the opposite of what the reader sees, defaults included", () => {
    const onToggleGroup = vi.fn();
    rail(compact, { onToggleGroup });
    fireEvent.click(within(screen.getByTestId("rail-group-development")).getAllByRole("button")[0]);
    fireEvent.click(within(screen.getByTestId("rail-group-ecosystem")).getAllByRole("button")[0]);
    expect(onToggleGroup.mock.calls).toEqual([
      ["development", true],
      ["ecosystem", false],
    ]);
  });

  it("navigates by key and hides the project tier when it has no entries", () => {
    const onNavigate = vi.fn();
    rail(compact, { onNavigate, projectItems: [] });
    fireEvent.click(button(/^Overview/));
    expect(onNavigate).toHaveBeenCalledWith("overview");
    expect(within(nav()).queryByRole("button", { name: /^Dashboard/ })).toBeNull();
  });

  it("names the collapse handle for the way it moves", () => {
    const onToggleCollapsed = vi.fn();
    rail(compact, { onToggleCollapsed });
    fireEvent.click(button(compact ? "Expand sidebar" : "Collapse sidebar"));
    expect(onToggleCollapsed).toHaveBeenCalledOnce();
  });
});
