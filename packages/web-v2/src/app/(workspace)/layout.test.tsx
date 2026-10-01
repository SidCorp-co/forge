// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);

const nav = vi.hoisted(() => ({ pathname: "/", push: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: nav.push, replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(),
}));

const PROJECTS = [
  { id: "p1", slug: "forge-dev", name: "Forge Dev", orgId: "o1", role: "admin" },
  { id: "p2", slug: "other", name: "Other", orgId: "o1", role: "admin" },
];

vi.mock("@/providers/auth-provider", () => ({
  useAuth: () => ({ user: { id: "u1", email: "me@example.com" }, isLoading: false, logout: vi.fn() }),
}));
vi.mock("@/providers/toast-provider", () => ({
  useToast: () => ({ toast: vi.fn() }),
  ToastLane: () => null,
}));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: PROJECTS, isLoading: false, isError: false }),
  useOrgScopedProjects: () => ({ projects: PROJECTS, projectIds: new Set(["p1", "p2"]) }),
  useProjectsConsole: () => ({ items: [], toggle: vi.fn() }),
}));
vi.mock("@/features/projects/pins", () => ({ usePinnedProjects: () => ({ pinnedIds: new Set() }) }));
vi.mock("@/features/projects/components/project-flyout", () => ({ ProjectFlyout: () => null }));
vi.mock("@/features/orgs/active-org", () => ({
  ActiveOrgProvider: ({ children }: { children: React.ReactNode }) => children,
  useActiveOrg: () => ({ orgs: [], activeOrgId: null, setActiveOrg: vi.fn() }),
}));
vi.mock("@/features/orgs/components/org-switcher", () => ({ OrgSwitcher: () => null }));
vi.mock("@/features/attention/hooks", () => ({ useAttention: () => ({ total: 3 }) }));
vi.mock("@/features/whats-new/hooks", () => ({ useWhatsNewStatus: () => ({ hasUnseen: false }) }));
vi.mock("@/features/version", () => ({ ForgeVersion: () => null }));
vi.mock("@/features/issues/use-unblock-cascade", () => ({ useUnblockCascadeToasts: () => {} }));
vi.mock("@/features/notifications/hooks", () => ({ useOpenCount: () => ({ data: { count: 2 } }) }));
vi.mock("@/features/notifications/components/notifications-bell", () => ({
  NotificationsBell: ({ open }: { open: boolean }) => (open ? <div data-testid="bell-open" /> : null),
}));
vi.mock("@/features/conversations/hooks", () => ({
  useConversationsAcrossProjects: () => ({ rows: [], isLoading: false, error: null, refetch: vi.fn() }),
  useRenameConversation: () => ({ mutate: vi.fn() }),
  useArchiveConversation: () => ({ mutate: vi.fn() }),
  useDeleteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  usePinConversation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/ecosystem/hooks", () => ({
  useProjectEcosystems: () => ({ data: { memberships: [] }, isLoading: false, isError: false }),
}));

import WorkspaceLayout from "./layout";

function at(route: string) {
  const [path, query] = route.split("?");
  nav.pathname = path as string;
  window.history.replaceState(null, "", route);
  void query;
}

function mount() {
  return render(
    <WorkspaceLayout>
      <p>page</p>
    </WorkspaceLayout>,
  );
}

function modeTab(name: "Activity" | "Chat") {
  return within(screen.getByTestId("mode-switch")).getByRole("tab", { name });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  nav.push.mockReset();
  nav.replace.mockReset();
});
afterEach(cleanup);

describe("the shell's mode follows the route", () => {
  it("is Chat on a /chat route, with the chat sidebar in place of the nav", () => {
    at("/chat/forge-dev");
    mount();
    expect(modeTab("Chat")).toHaveAttribute("aria-selected", "true");
    expect(modeTab("Activity")).toHaveAttribute("aria-selected", "false");
    expect(screen.getByTestId("chat-sidebar")).toBeInTheDocument();
  });

  it("is Activity everywhere else", () => {
    at("/projects/forge-dev/issues");
    mount();
    expect(modeTab("Activity")).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("chat-sidebar")).toBeNull();
  });
});

describe("switching modes", () => {
  it("returns to the route the mode was last on", () => {
    at("/projects/forge-dev/issues?filter=open");
    const view = mount();
    at("/chat/forge-dev/c-1");
    view.rerender(
      <WorkspaceLayout>
        <p>page</p>
      </WorkspaceLayout>,
    );
    fireEvent.click(modeTab("Activity"));
    expect(nav.push).toHaveBeenLastCalledWith("/projects/forge-dev/issues?filter=open");
  });

  it("keeps the project selected in the mode being left", () => {
    at("/projects/forge-dev/issues");
    const view = mount();
    at("/chat/other");
    view.rerender(
      <WorkspaceLayout>
        <p>page</p>
      </WorkspaceLayout>,
    );
    fireEvent.click(modeTab("Activity"));
    expect(nav.push).toHaveBeenLastCalledWith("/projects/other/issues");
  });
});

describe("every top-bar item has a new home", () => {
  it.each([
    ["the compact rail", "/projects/forge-dev/issues", true],
    ["the expanded rail", "/projects/forge-dev/issues", false],
    ["the chat sidebar", "/chat/forge-dev", false],
  ])("puts search, the bell and the account in %s", (_, route, collapsed) => {
    window.localStorage.setItem("web-v2:sidebar", JSON.stringify({ collapsed, groupOpen: {} }));
    at(route);
    mount();
    expect(screen.queryByRole("banner")).toBeNull();
    const side = within(screen.getByTestId("desktop-sidebar"));
    expect(side.getByTestId("mode-switch")).toBeInTheDocument();
    expect(side.getByRole("button", { name: "Search (⌘K)" })).toBeInTheDocument();
    expect(side.getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    fireEvent.click(side.getByRole("button", { name: "Notifications, 2 open" }));
    expect(screen.getByTestId("bell-open")).toBeInTheDocument();
  });

  it("puts the breadcrumb above an Activity page", () => {
    at("/projects/forge-dev/issues");
    mount();
    const crumbs = within(screen.getByTestId("page-crumbs"));
    expect(crumbs.getByText("Forge Dev")).toBeInTheDocument();
    expect(crumbs.getByText("Issues")).toBeInTheDocument();
  });

  it("opens the command palette from the sidebar, and it holds New issue and New chat", () => {
    at("/projects/forge-dev/issues");
    mount();
    fireEvent.click(screen.getAllByRole("button", { name: "Search (⌘K)" })[0] as HTMLElement);
    expect(screen.getByText("Create issue")).toBeInTheDocument();
    expect(screen.getByText("New chat")).toBeInTheDocument();
  });

  it("carries search, the bell and the account in the mobile More drawer", () => {
    at("/runners");
    mount();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const drawer = within(screen.getByRole("dialog", { name: "Navigation" }));
    expect(drawer.getByRole("button", { name: "Search (⌘K)" })).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: "Notifications, 2 open" })).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: /Account & Settings/ })).toBeInTheDocument();
    expect(drawer.getByRole("button", { name: /Sign out/ })).toBeInTheDocument();
  });
});

describe("the Ecosystem group", () => {
  it("sits in the expanded Activity sidebar and opens the register on the selected project", () => {
    window.localStorage.setItem("web-v2:sidebar", JSON.stringify({ collapsed: false, groupOpen: {} }));
    at("/projects/forge-dev/issues");
    mount();
    const side = within(screen.getByTestId("desktop-sidebar"));
    expect(side.getByText("Ecosystem")).toBeInTheDocument();
    fireEvent.click(side.getByRole("button", { name: "Held" }));
    expect(nav.push).toHaveBeenLastCalledWith("/projects/forge-dev/ecosystem/channel?status=held");
  });

  it("sits in the compact rail too", () => {
    at("/projects/forge-dev/issues");
    mount();
    const side = within(screen.getByTestId("desktop-sidebar"));
    fireEvent.click(side.getByRole("button", { name: "Contracts" }));
    expect(nav.push).toHaveBeenLastCalledWith("/projects/forge-dev/ecosystem/contracts");
  });
});

describe("the mobile tabs", () => {
  it("are Activity · Chat · Attention · More, shown below md where the sidebar is hidden", () => {
    at("/runners");
    mount();
    const tabs = screen.getByRole("navigation", { name: "Primary" });
    expect(tabs).toHaveClass("md:hidden");
    expect(within(tabs).getAllByRole("button").map((b) => b.textContent?.replace(/\d+/g, ""))).toEqual([
      "Activity",
      "Chat",
      "Attention",
      "More",
    ]);
    act(() => {
      fireEvent.click(within(tabs).getByRole("button", { name: "Chat" }));
    });
    expect(nav.push).toHaveBeenLastCalledWith("/chat/forge-dev");
  });
});
