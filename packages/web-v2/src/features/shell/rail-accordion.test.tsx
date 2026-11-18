// The rail's groups are an accordion per tier and its foot is one row (ISS-1331, the owner on
// 2026-11-18): opening Product closes Delivery and the other way round, in the labelled rail and the
// compact one; the group holding the current page opens when the person navigates into it, but they
// can close it, and opening another closes it; the choice is the caller's and persists there. The foot
// is the account chip and the collapse toggle, and What's new, Help, the guides and the version (last,
// muted) are in the chip's menu, its dot on the chip.
// @direct-test-of packages/web-v2/src/design/patterns/nav-rail.tsx
// @direct-test-of packages/web-v2/src/design/patterns/nav-rail-groups.ts
// @direct-test-of packages/web-v2/src/design/patterns/menu.tsx
// @direct-test-of packages/web-v2/src/features/whats-new/components/whats-new-button.tsx
// @direct-test-of packages/web-v2/src/features/tours/components/help-tours-button.tsx

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NavEntry, NavRail } from "@/design";
import { forgetOpenedWhatsNew } from "@/features/whats-new";
import { fakeCore, renderWithQuery } from "@/test/render";
import { WorkspaceSidebar } from "./components/workspace-sidebar";
import { useSidebar } from "./sidebar";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const WORKSPACE: NavEntry[] = [{ key: "overview", label: "Overview", icon: "grid" }];
const PROJECT: NavEntry[] = [
  { key: "proj-overview", label: "Dashboard", icon: "grid" },
  {
    key: "product",
    label: "Product",
    icon: "folder",
    defaultOpen: true,
    items: [
      { key: "proj-feedback", label: "Feedback", icon: "chat" },
      { key: "proj-requirements", label: "Requirements", icon: "book" },
    ],
  },
  {
    key: "delivery",
    label: "Delivery",
    icon: "code",
    items: [
      { key: "proj-issues", label: "Issues", icon: "list" },
      { key: "proj-modules", label: "Modules", icon: "rows" },
    ],
  },
];

/** The rail over the sidebar's own persisted choice, as the shell mounts it, at a page the test moves. */
const at: { go: (key: string) => void } = { go: () => {} };
function Shell({ compact, start }: { compact: boolean; start: string }) {
  const sidebar = useSidebar();
  const [activeKey, setActiveKey] = useState(start);
  at.go = setActiveKey;
  return (
    <NavRail
      compact={compact}
      workspaceItems={WORKSPACE}
      projectItems={PROJECT}
      activeKey={activeKey}
      onNavigate={setActiveKey}
      groupOpen={sidebar.groupOpen}
      onChooseGroups={sidebar.chooseGroups}
    />
  );
}

const head = (key: string) => {
  const [button] = within(screen.getByTestId(`rail-group-${key}`)).getAllByRole("button");
  if (!button) throw new Error(`no head for ${key}`);
  return button;
};
const isOpen = (key: string) => head(key).getAttribute("aria-expanded") === "true";
const opened = () => ["product", "delivery"].filter(isOpen);
const stored = () => (JSON.parse(localStorage.getItem("web-v2:sidebar") ?? "{}") as { groupOpen?: Record<string, boolean> }).groupOpen;

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  forgetOpenedWhatsNew();
});

describe.each([
  ["labelled", false],
  ["compact", true],
])("the %s rail's groups", (_name, compact) => {
  it("open one at a time in a tier, and the choice persists", async () => {
    const user = userEvent.setup();
    render(<Shell compact={compact} start="overview" />);
    expect(opened()).toEqual(["product"]);
    await user.click(head("delivery"));
    expect(opened()).toEqual(["delivery"]);
    expect(stored()).toEqual({ product: false, delivery: true });
    await user.click(head("product"));
    expect(opened()).toEqual(["product"]);
    expect(stored()).toEqual({ product: true, delivery: false });
    // a group closed by hand stays closed, and none is open in its tier
    await user.click(head("product"));
    expect(opened()).toEqual([]);
    cleanup();
    render(<Shell compact={compact} start="overview" />);
    await act(async () => {});
    expect(opened(), "the choice did not persist").toEqual([]);
  });

  it("open the current page's group on arrival, which the person can close, and opening another closes it", async () => {
    const user = userEvent.setup();
    render(<Shell compact={compact} start="proj-issues" />);
    expect(opened()).toEqual(["delivery"]);
    await user.click(head("delivery"));
    expect(opened(), "the group holding the current page could not be closed").toEqual([]);
    await user.click(head("product"));
    expect(opened()).toEqual(["product"]);
    await user.click(head("delivery"));
    expect(opened()).toEqual(["delivery"]);
  });

  it("open the group a navigation moves into, closing the one the person had open", async () => {
    const user = userEvent.setup();
    render(<Shell compact={compact} start="proj-feedback" />);
    await user.click(head("product"));
    expect(opened()).toEqual([]);
    act(() => at.go("proj-issues"));
    expect(opened()).toEqual(["delivery"]);
    act(() => at.go("proj-feedback"));
    expect(opened()).toEqual(["product"]);
  });

  it("read a choice stored before the accordion that opens both as one open group", () => {
    localStorage.setItem("web-v2:sidebar", JSON.stringify({ collapsed: compact, groupOpen: { product: true, delivery: true } }));
    render(<Shell compact={compact} start="overview" />);
    expect(opened()).toEqual(["product"]);
  });
});

describe("the rail's foot", () => {
  const menu = [
    { label: "What's new", icon: "star" as const, onSelect: vi.fn(), dot: "a new release", separatorBefore: true },
    { label: "Help", icon: "help" as const, onSelect: vi.fn() },
    { label: "Docs", icon: "book" as const, onSelect: vi.fn() },
  ];
  const foot = (over: Partial<React.ComponentProps<typeof NavRail>> = {}) =>
    render(
      <NavRail
        workspaceItems={WORKSPACE}
        activeKey="overview"
        user={{ initials: "OR" }}
        onAccount={vi.fn()}
        onSignOut={vi.fn()}
        onToggleCollapsed={vi.fn()}
        menu={menu}
        version={<span>Forge v0.4.0-dev.737</span>}
        {...over}
      />,
    );

  it.each([false, true])("is one row, the chip and the toggle, compact %s", (compact) => {
    foot({ compact });
    const row = screen.getByTestId("rail-footer");
    expect(within(row).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Account menu", compact ? "Expand sidebar" : "Collapse sidebar"]);
    expect(row.textContent).not.toMatch(/What's new|Help|Forge v/);
  });

  it("holds What's new, Help and the guides in the chip's menu, the version its last, muted line", async () => {
    const user = userEvent.setup();
    foot();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const list = await screen.findByRole("menu");
    expect(within(list).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Account & Settings", "What's new, a new release", "Help", "Docs", "Sign out"]);
    const note = within(list).getByTestId("menu-footnote");
    expect(note.textContent).toBe("Forge v0.4.0-dev.737");
    expect(note.className).toMatch(/text-subtle/);
    expect(list.lastElementChild).toBe(note);
    await user.click(within(list).getByRole("menuitem", { name: /^Help/ }));
    expect(menu[1]?.onSelect).toHaveBeenCalledOnce();
  });

  it("dots the chip while something in its menu is new, and names it", () => {
    foot({ menuDot: "a new release" });
    expect(screen.getByTestId("account-dot")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account menu, a new release" })).toBeTruthy();
    cleanup();
    foot();
    expect(screen.queryByTestId("account-dot")).toBeNull();
  });
});

describe("the shell's account chip", () => {
  const noop = () => {};
  /** Core with the serving release owed or not; the seen mark fails, so an owed release stays owed. */
  const serve = (owed: boolean) =>
    fakeCore((call) => {
      const release = { version: "0.4.0-dev.737", name: null, summary: null, releasedAt: "2026-11-19T01:00:00.000Z", owed, highlights: [], changes: [] };
      if (call.path === "/me/whats-new/summary") return { body: { environment: "dev", release: { version: release.version, owed } } };
      if (call.path === "/me/whats-new") return { body: { environment: "dev", release } };
      if (call.path === "/version") return { body: { version: "0.4.0-dev.737", sourceCommit: null } };
      if (call.method === "PUT") return { status: 500, body: { error: "down" } };
      return undefined;
    });
  const sidebar = () =>
    renderWithQuery(
      <WorkspaceSidebar
        collapsed={false}
        onToggleCollapsed={noop}
        groupOpen={{}}
        onChooseGroups={noop}
        activeKey="overview"
        attentionCount={0}
        railSlug={null}
        rail={{ projectMark: null, switcherProjects: [], togglePin: noop }}
        badges={{}}
        onNavigate={noop}
        onRoute={noop}
        onSignOut={noop}
        userInitials="OR"
        search={() => null}
        bell={null}
      />,
    );

  it("dots the chip while What's new holds a release the person has not seen", async () => {
    serve(true);
    sidebar();
    expect(await screen.findByTestId("account-dot")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account menu, a new release", hidden: true })).toBeTruthy();
  });

  it("draws no dot once it is seen, and its menu ends on the version, muted", async () => {
    serve(false);
    const user = userEvent.setup();
    sidebar();
    const chip = await screen.findByRole("button", { name: "Account menu" });
    await waitFor(() => expect(screen.queryByTestId("account-dot")).toBeNull());
    await user.click(chip);
    const list = await screen.findByRole("menu");
    expect(within(list).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Account & Settings", "What's new", "Help", "Docs", "Sign out"]);
    await waitFor(() => expect(within(list).getByTestId("menu-footnote").textContent).toBe("Forge v0.4.0-dev.737"));
  });
});
