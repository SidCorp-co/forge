// @vitest-environment jsdom
//
// The first block is every state the screen got WRONG on forge-beta on
// 2026-09-06: a name printed twice, "no connections yet" over a scope that was
// merely hiding them, and management buttons offered to a principal the API
// answers 403. The second is what ISS-1035 asks of the grouping: the apps
// first, the credentials of the one you came for second, and a filter that
// cannot leave its own match behind a shut header.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { IntegrationsScreen } from "./integrations-screen";

expect.extend(matchers);
afterEach(cleanup);

const connectionItems = vi.fn<() => ConnectionDirectoryItem[]>();
const activeOrg = vi.fn<() => Record<string, unknown> | null>();
const orgs = vi.fn<() => Array<Record<string, unknown>>>();
const canManage = vi.fn<() => boolean>();
const removeMutate = vi.fn();

vi.mock("../hooks", () => ({
  useConnections: () => ({
    data: { items: connectionItems() },
    isLoading: false,
    isError: false,
  }),
  useUpdateConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveConnection: () => ({ mutate: removeMutate, isPending: false }),
  useCanManageConnection: () => canManage(),
}));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrg: activeOrg() }) }));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: orgs() }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: [{ id: "proj-a", name: "forge-dev" }] }),
}));
vi.mock("./connection-edit-drawer", () => ({ ConnectionEditDrawer: () => null }));

function conn(over: Partial<ConnectionDirectoryItem> = {}): ConnectionDirectoryItem {
  return {
    id: "conn-1",
    ownerType: "user",
    ownerId: "user-1",
    provider: "coolify",
    displayName: null,
    config: {},
    active: true,
    lastHealthStatus: "ok",
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    usage: { bindings: [] },
    ...over,
  } as ConnectionDirectoryItem;
}

const BOUND = {
  bindings: [{ id: "b1", projectId: "proj-a", environment: "prod", label: "", active: true }],
};

const PERSONAL = { id: "org-personal", name: "Personal", isPersonal: true };
const TEAM = { id: "org-1", name: "SidCorp", isPersonal: false };

/** The section header for an app, which is also its collapse/expand control. */
function appHeader(label: string) {
  return screen.getByRole("button", { expanded: undefined, name: new RegExp(`^${label}`) });
}

/** Open an app's section — nothing under a header is rendered until it is. */
function openApp(label: string) {
  fireEvent.click(appHeader(label));
}

/** The row for one connection, by the label its drawer hand-off carries. */
function row(title: string) {
  return screen.getByRole("button", { name: `Manage connection ${title}` });
}

describe("IntegrationsScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    connectionItems.mockReturnValue([]);
    activeOrg.mockReturnValue(PERSONAL);
    orgs.mockReturnValue([{ id: "org-1", name: "SidCorp", role: "member" }]);
    canManage.mockReturnValue(true);
  });

  it("prints the provider label once in a row, not as both the title and a pill", () => {
    connectionItems.mockReturnValue([conn()]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(within(row("Coolify deploy")).getAllByText("Coolify deploy")).toHaveLength(1);
  });

  it("keeps the provider pill when the connection carries a name of its own", () => {
    connectionItems.mockReturnValue([conn({ displayName: "Prod deploy token" })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const r = row("Prod deploy token");
    expect(within(r).getByText("Prod deploy token")).toBeInTheDocument();
    expect(within(r).getByText("Coolify deploy")).toBeInTheDocument();
  });

  it("names the projects using a credential, which is what tells two apart", () => {
    connectionItems.mockReturnValue([conn({ usage: BOUND })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(screen.getByText("forge-dev")).toBeInTheDocument();
    expect(screen.getByText("Production")).toBeInTheDocument();
  });

  it("offers no control that manages a binding, only the credential's own", () => {
    connectionItems.mockReturnValue([conn({ usage: BOUND })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const names = within(row("Coolify deploy"))
      .getAllByRole("button")
      .map((b) => b.textContent?.trim());
    expect(names).toEqual(["Disable", "Remove"]);
  });

  it("shows the endpoint a credential points at", () => {
    connectionItems.mockReturnValue([conn({ config: { baseUrl: "https://deploy.example.com" } })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(screen.getByText("deploy.example.com")).toBeInTheDocument();
  });

  it("says the scope is hiding connections instead of claiming there are none", () => {
    connectionItems.mockReturnValue([conn({ ownerType: "org", ownerId: "org-1" })]);
    activeOrg.mockReturnValue(PERSONAL);
    render(<IntegrationsScreen />);
    expect(screen.queryByText("No connections yet")).toBeNull();
    expect(screen.getByText(/No connections in your personal space/)).toBeInTheDocument();
    expect(screen.getByText(/1 connection in your other spaces/)).toBeInTheDocument();
  });

  it("claims there are none only when there really are none", () => {
    connectionItems.mockReturnValue([]);
    render(<IntegrationsScreen />);
    expect(screen.getByText("No connections yet")).toBeInTheDocument();
  });

  it("distinguishes a filter that matched nothing from an empty workspace", () => {
    connectionItems.mockReturnValue([conn(), conn({ id: "conn-2", provider: "sentry" })]);
    render(<IntegrationsScreen />);
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "nothing-matches-this" },
    });
    expect(screen.getByText("No connection matches")).toBeInTheDocument();
    expect(screen.queryByText("No connections yet")).toBeNull();
  });

  it("filters by project name, not only by the credential's own fields", () => {
    connectionItems.mockReturnValue([
      conn({ usage: BOUND }),
      conn({ id: "conn-2", provider: "sentry" }),
    ]);
    render(<IntegrationsScreen />);
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "forge-dev" },
    });
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("offers Remove on the row, behind a confirmation that names the cost", () => {
    connectionItems.mockReturnValue([conn({ usage: BOUND })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("Disconnects 1 project.")).toBeInTheDocument();
    expect(removeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(removeMutate).toHaveBeenCalledWith("conn-1");
  });

  it("explains read-only rather than offering buttons the API answers 403", () => {
    canManage.mockReturnValue(false);
    activeOrg.mockReturnValue(TEAM);
    connectionItems.mockReturnValue([conn({ ownerType: "org", ownerId: "org-1" })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.getByText(/only an admin of SidCorp/)).toBeInTheDocument();
  });
});

describe("IntegrationsScreen, grouped by app", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    activeOrg.mockReturnValue(PERSONAL);
    orgs.mockReturnValue([{ id: "org-1", name: "SidCorp", role: "member" }]);
    canManage.mockReturnValue(true);
    connectionItems.mockReturnValue([
      conn({ id: "c1", displayName: "Staging token" }),
      conn({ id: "c2", displayName: "Prod token", active: false }),
      conn({ id: "s1", provider: "sentry", displayName: "Sentry key" }),
    ]);
  });

  it("renders one section per app rather than one card per connection", () => {
    render(<IntegrationsScreen />);
    expect(appHeader("Coolify deploy")).toBeInTheDocument();
    expect(appHeader("Sentry")).toBeInTheDocument();
  });

  it("states how many connections an app holds, and how many are off", () => {
    render(<IntegrationsScreen />);
    expect(within(appHeader("Coolify deploy")).getByText("2 connections · 1 off")).toBeInTheDocument();
    expect(within(appHeader("Sentry")).getByText("1 connection")).toBeInTheDocument();
  });

  it("states how many of an app's connections want attention", () => {
    connectionItems.mockReturnValue([
      conn({ id: "c1", displayName: "Staging token", lastHealthStatus: "needs_reauth" }),
      conn({ id: "c2", displayName: "Prod token" }),
    ]);
    render(<IntegrationsScreen />);
    expect(
      within(appHeader("Coolify deploy")).getByText("2 connections · 1 need attention"),
    ).toBeInTheDocument();
  });

  it("puts nothing but the app headers on the screen on a first visit", () => {
    render(<IntegrationsScreen />);
    expect(screen.queryByText("Staging token")).toBeNull();
    expect(screen.queryByText("Sentry key")).toBeNull();
    expect(appHeader("Coolify deploy")).toHaveAttribute("aria-expanded", "false");
  });

  it("renders an app's connections once its header is clicked, and only that app's", () => {
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(screen.getByText("Staging token")).toBeInTheDocument();
    expect(screen.getByText("Prod token")).toBeInTheDocument();
    expect(screen.queryByText("Sentry key")).toBeNull();
  });

  it("stops rendering an app's connections when its open header is clicked", () => {
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(screen.getByText("Staging token")).toBeInTheDocument();
    openApp("Coolify deploy");
    expect(screen.queryByText("Staging token")).toBeNull();
  });

  it("names the element holding its rows, so the disclosure is followable", () => {
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const header = appHeader("Coolify deploy");
    const controls = header.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const rows = document.getElementById(controls as string);
    expect(rows).not.toBeNull();
    expect(within(rows as HTMLElement).getByText("Staging token")).toBeInTheDocument();
  });

  it("still has the app open when the operator comes back to the page", () => {
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    cleanup();
    render(<IntegrationsScreen />);
    expect(screen.getByText("Staging token")).toBeInTheDocument();
    expect(screen.queryByText("Sentry key")).toBeNull();
  });

  it("does not reopen an app the operator closed again before leaving", () => {
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    openApp("Coolify deploy");
    cleanup();
    render(<IntegrationsScreen />);
    expect(screen.queryByText("Staging token")).toBeNull();
  });

  it("renders a search match without the operator opening the app holding it", () => {
    render(<IntegrationsScreen />);
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "Sentry key" },
    });
    expect(screen.getByText("Sentry key")).toBeInTheDocument();
  });

  it("leaves only the chosen app's section when the provider filter is used", () => {
    render(<IntegrationsScreen />);
    fireEvent.change(screen.getByLabelText("Filter by provider"), { target: { value: "sentry" } });
    expect(screen.queryByRole("button", { name: /^Coolify deploy/ })).toBeNull();
    expect(screen.getByText("Sentry key")).toBeInTheDocument();
  });

  it("lets a section revealed by a filter still be closed by its header", () => {
    render(<IntegrationsScreen />);
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "token" } });
    expect(screen.getByText("Staging token")).toBeInTheDocument();
    openApp("Coolify deploy");
    expect(screen.queryByText("Staging token")).toBeNull();
  });

  it("gives back the operator's own choice when the filter is cleared", () => {
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const search = screen.getByLabelText("Search connections");
    // Reveals Sentry, then shuts Coolify — neither may reach the choice above.
    fireEvent.change(search, { target: { value: "e" } });
    openApp("Coolify deploy");
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("Staging token")).toBeInTheDocument();
    expect(screen.queryByText("Sentry key")).toBeNull();
  });

  it("does not carry a collapse made under one filter into the next", () => {
    render(<IntegrationsScreen />);
    const search = screen.getByLabelText("Search connections");
    fireEvent.change(search, { target: { value: "token" } });
    openApp("Coolify deploy");
    expect(screen.queryByText("Staging token")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    fireEvent.change(search, { target: { value: "token" } });
    expect(screen.getByText("Staging token")).toBeInTheDocument();
  });
});

describe("IntegrationsScreen, a filter that changes under the operator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    activeOrg.mockReturnValue(PERSONAL);
    orgs.mockReturnValue([{ id: "org-1", name: "SidCorp", role: "member" }]);
    canManage.mockReturnValue(true);
    connectionItems.mockReturnValue([
      conn({ id: "c1", displayName: "Staging token" }),
      conn({ id: "s1", provider: "sentry", displayName: "Sentry key" }),
    ]);
  });

  it("reveals a match when the search CHANGES, not only when it is first typed", () => {
    render(<IntegrationsScreen />);
    const search = screen.getByLabelText("Search connections");
    // One filter, both apps revealed; the operator shuts Coolify under it.
    fireEvent.change(search, { target: { value: "e" } });
    expect(screen.getByText("Staging token")).toBeInTheDocument();
    openApp("Coolify deploy");
    expect(screen.queryByText("Staging token")).toBeNull();
    // A DIFFERENT search is a new question, and its match may not stay hidden
    // behind a header shut in answer to the last one.
    fireEvent.change(search, { target: { value: "Staging" } });
    expect(screen.getByText("Staging token")).toBeInTheDocument();
  });

  it("reveals a match when the provider filter CHANGES under an active search", () => {
    render(<IntegrationsScreen />);
    fireEvent.change(screen.getByLabelText("Search connections"), { target: { value: "e" } });
    openApp("Sentry");
    expect(screen.queryByText("Sentry key")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter by provider"), { target: { value: "sentry" } });
    expect(screen.getByText("Sentry key")).toBeInTheDocument();
  });

  it("names an element that exists while the section is shut, not a dangling id", () => {
    render(<IntegrationsScreen />);
    const header = appHeader("Coolify deploy");
    expect(header).toHaveAttribute("aria-expanded", "false");
    const controls = header.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls as string)).not.toBeNull();
    expect(screen.queryByText("Staging token")).toBeNull();
  });
});
