// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
vi.mock("@/features/orgs/components/org-switcher", () => ({
  OrgSwitcher: ({ variant }: { variant: string }) => <button type="button" data-testid={`org-switcher-${variant}`}>Org</button>,
}));
vi.mock("@/features/releases/versions-hooks", () => ({ useAwaitingApprovalCount: () => 2 }));
vi.mock("@/features/workflows/hooks", () => ({ useDesignsAwaitingCount: () => undefined }));
vi.mock("@/features/conversations/components/conversation-chat", () => ({
  ConversationChat: ({ projectId, initialDraft }: { projectId: string; initialDraft?: string }) => (
    <div data-testid="dock-chat" data-project={projectId} data-draft={initialDraft ?? ""} />
  ),
}));
vi.mock("@/features/conversations/components/start-conversation", () => ({ StartConversation: () => null }));
vi.mock("@/lib/ws/use-room", () => ({ useRoom: () => {} }));
vi.mock("@/features/attention/hooks", () => ({ useAttention: () => ({ total: 3 }) }));
vi.mock("@/features/whats-new/hooks", () => ({ useWhatsNewStatus: () => ({ hasUnseen: false }) }));
vi.mock("@/features/version", () => ({ ForgeVersion: () => null }));
vi.mock("@/features/issues/use-unblock-cascade", () => ({ useUnblockCascadeToasts: () => {} }));
vi.mock("@/features/notifications/hooks", () => ({ useOpenCount: () => ({ data: { count: 2 } }) }));
vi.mock("@/features/notifications/components/notifications-bell", () => ({
  NotificationsBell: ({ open }: { open: boolean }) => (open ? <div data-testid="bell-open" /> : null),
}));
vi.mock("@/features/conversations/hooks", () => ({
  useConversation: () => ({ data: undefined }),
  useConversationsAcrossProjects: () => ({ rows: [], isLoading: false, error: null, refetch: vi.fn() }),
  useRenameConversation: () => ({ mutate: vi.fn() }),
  useArchiveConversation: () => ({ mutate: vi.fn() }),
  useDeleteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  usePinConversation: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/features/ecosystem/hooks", () => ({
  useProjectEcosystems: () => ({ data: { memberships: [] }, isLoading: false, isError: false }),
  useMyEcosystems: () => ({ data: undefined, isLoading: true, isError: false }),
}));

import WorkspaceLayout from "./layout";

function at(route: string) {
  nav.pathname = route.split("?")[0] as string;
  window.history.replaceState(null, "", route);
}

function mount() {
  return render(
    <WorkspaceLayout>
      <p>page</p>
    </WorkspaceLayout>,
  );
}

const rail = (collapsed: boolean) =>
  window.localStorage.setItem("web-v2:sidebar", JSON.stringify({ collapsed, groupOpen: {} }));
const side = () => within(screen.getByTestId("desktop-sidebar"));

Element.prototype.scrollIntoView = vi.fn();
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  nav.push.mockReset();
  nav.replace.mockReset();
  window.matchMedia = ((q: string) => ({
    matches: q.includes("min-width"),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe("the logo row", () => {
  it("is the logo, the organization picker, search and the bell, with no mode switch", () => {
    rail(false);
    at("/projects/forge-dev/issues");
    mount();
    const brand = within(side().getByTestId("brand-row"));
    expect(brand.getByAltText("Forge")).toBeInTheDocument();
    expect(brand.getByTestId("org-switcher-brand")).toBeInTheDocument();
    expect(brand.getByRole("button", { name: "Notifications, 2 open" })).toBeInTheDocument();
    expect(brand.queryByRole("button", { name: "Collapse sidebar" })).toBeNull();
    expect(side().queryByTestId("org-switcher-expanded")).toBeNull();
    expect(screen.queryByTestId("mode-switch")).toBeNull();
  });

  it("carries the bell beside the logo on the compact rail too", () => {
    rail(true);
    at("/projects/forge-dev/issues");
    mount();
    const brand = within(side().getByTestId("brand-row"));
    expect(brand.getByRole("button", { name: "Notifications, 2 open" })).toBeInTheDocument();
    expect(brand.queryByRole("button", { name: "Expand sidebar" })).toBeNull();
  });
});

describe("the sidebar footer", () => {
  it.each([
    ["the expanded rail", false, "Collapse sidebar"],
    ["the compact rail", true, "Expand sidebar"],
  ])("puts the collapse handle right after the account menu on %s", (_, collapsed, handle) => {
    rail(collapsed);
    at("/projects/forge-dev/issues");
    mount();
    const account = side().getByRole("button", { name: "Account menu" });
    const toggle = side().getByRole("button", { name: handle });
    expect(account.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ["the expanded rail", false],
    ["the compact rail", true],
  ])("has no Docs or What's New rows on %s: the version opens What's New and the book opens Docs", (_, collapsed) => {
    rail(collapsed);
    at("/projects/forge-dev/issues");
    mount();
    expect(side().queryByRole("button", { name: /^What's New/ })).toBeNull();
    fireEvent.click(side().getByRole("button", { name: /What's New/ }));
    expect(nav.push).toHaveBeenLastCalledWith("/whats-new");
    fireEvent.click(side().getByRole("button", { name: "Docs" }));
    expect(nav.push).toHaveBeenLastCalledWith("/docs");
  });
});

describe("the top bar", () => {
  it("prints no breadcrumb on any page", () => {
    at("/projects/forge-dev/settings");
    mount();
    expect(screen.queryByTestId("page-crumbs")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });
});

describe("the project menu", () => {
  it("lists Dashboard, Requirements, Workflows, Issues, Agents, Automation and Releases, and no Library", () => {
    rail(false);
    at("/projects/forge-dev");
    mount();
    for (const name of ["Dashboard", "Requirements", "Workflows", "Issues", "Agents", "Automation", "Releases"]) {
      expect(side().getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(side().queryByRole("button", { name: /^Library/ })).toBeNull();
  });

  it("opens the Automation group on a page inside it and lights that page", () => {
    rail(false);
    at("/projects/forge-dev/automation/improvements");
    mount();
    expect(side().getByRole("button", { name: "Automation" })).toHaveAttribute("aria-expanded", "true");
    expect(side().getByRole("button", { name: "Improvements" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(side().getByRole("button", { name: "Schedules" }));
    expect(nav.push).toHaveBeenLastCalledWith("/projects/forge-dev/automation/schedules");
  });

  it("keeps the Automation group shut until it is opened, then shows its two pages", () => {
    rail(false);
    at("/projects/forge-dev/issues");
    mount();
    expect(side().queryByRole("button", { name: "Schedules" })).toBeNull();
    fireEvent.click(side().getByRole("button", { name: "Automation" }));
    expect(side().getByRole("button", { name: "Schedules" })).toBeInTheDocument();
    expect(side().getByRole("button", { name: "Improvements" })).toBeInTheDocument();
  });

  it("counts the versions awaiting approval on Releases", () => {
    rail(false);
    at("/projects/forge-dev/releases");
    mount();
    expect(side().getByRole("button", { name: /^Releases/ })).toHaveTextContent("2");
  });
});

describe("the chat dock", () => {
  it.each([
    ["the expanded rail", false],
    ["the compact rail", true],
  ])("opens from the top bar with %s over the page, in the selected project, and closes", (_, collapsed) => {
    rail(collapsed);
    at("/projects/other/issues");
    mount();
    expect(screen.queryByTestId("chat-dock")).toBeNull();
    expect(side().queryByRole("button", { name: "Ask Agent" })).toBeNull();
    const bar = within(screen.getByRole("banner"));
    fireEvent.click(bar.getByRole("button", { name: "Ask Agent" }));
    expect(bar.getByRole("button", { name: "Ask Agent" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("page")).toBeInTheDocument();
    expect(screen.getByTestId("chat-dock")).toBeInTheDocument();
    expect(screen.getByTestId("dock-chat")).toHaveAttribute("data-project", "p2");
    fireEvent.click(screen.getByRole("button", { name: "Close Ask Agent" }));
    expect(screen.queryByTestId("chat-dock")).toBeNull();
  });

  it("is what New chat opens from ⌘K, which offers no Chat mode", () => {
    at("/projects/forge-dev/issues");
    mount();
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.queryByText("Go to Chat")).toBeNull();
    expect(screen.queryByText("Go to Activity")).toBeNull();
    fireEvent.click(screen.getByText("New chat"));
    expect(screen.getByTestId("dock-chat")).toHaveAttribute("data-project", "p1");
  });
});

describe("the sidebar's controls", () => {
  it.each([
    ["the compact rail", true],
    ["the expanded rail", false],
  ])("puts the bell, the account and search in %s", (_, collapsed) => {
    rail(collapsed);
    at("/projects/forge-dev/issues");
    mount();
    expect(side().getByRole("button", { name: "Account menu" })).toBeInTheDocument();
    expect(side().getByRole("button", { name: "Search (⌘K)" })).toBeInTheDocument();
    fireEvent.click(side().getByRole("button", { name: "Notifications, 2 open" }));
    expect(screen.getByTestId("bell-open")).toBeInTheDocument();
  });
});
