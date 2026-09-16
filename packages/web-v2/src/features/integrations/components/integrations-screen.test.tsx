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
  useProjectsIncludingArchived: () => ({
    data: [
      { id: "proj-a", name: "forge-dev" },
      { id: "proj-b", name: "forge-plugin" },
    ],
  }),
}));
// Renders its subject's id rather than nothing, so "the row hands this
// connection to the drawer" is an assertion and not an absence.
vi.mock("./connection-edit-drawer", () => ({
  ConnectionEditDrawer: ({ connection }: { connection: { id: string } }) => (
    <div data-testid="connection-edit-drawer">{connection.id}</div>
  ),
}));

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
  };
}

// Typed rather than inferred: `role` and `stages` are closed unions on
// ConnectionUsage, and an untyped object literal widens them to `string`, which
// vitest's transpile-only run never sees and `next build` fails on.
const BOUND: ConnectionDirectoryItem["usage"] = {
  bindings: [
    { id: "b1", projectId: "proj-a", role: "deploy", stages: ["live"], label: "", active: true },
  ],
};

const OTHER_BOUND: ConnectionDirectoryItem["usage"] = {
  bindings: [
    { id: "b2", projectId: "proj-b", role: "deploy", stages: ["live"], label: "", active: true },
  ],
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

/**
 * The control that opens one connection's drawer — a real button, not a div
 * wearing the role. Matched on the PREFIX because the accessible name carries
 * the row's discriminators after it, which is what keeps two unnamed
 * credentials of one app from being announced identically.
 */
function manageButton(title: string) {
  return screen.getByRole("button", { name: new RegExp(`^Manage connection ${title}(?: —|$)`) });
}

/** The whole row: that button, the status pill and the management controls beside it. */
function row(title: string) {
  return manageButton(title).parentElement as HTMLElement;
}

/** What a row offers on the CREDENTIAL — the drawer button is not one of those. */
function rowActionNames(title: string) {
  return within(row(title))
    .getAllByRole("button")
    .filter((b) => b !== manageButton(title))
    .map((b) => b.textContent?.trim());
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
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("offers no control that manages a binding, only the credential's own", () => {
    connectionItems.mockReturnValue([conn({ usage: BOUND })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(rowActionNames("Coolify deploy")).toEqual(["Disable", "Remove"]);
  });

  it("keeps the management buttons OUT of the button that opens the drawer", () => {
    // A control containing four other controls is what the card this row
    // replaced did, and it flattens the inner ones for assistive technology.
    connectionItems.mockReturnValue([conn({ usage: BOUND })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const manage = manageButton("Coolify deploy");
    expect(manage.tagName).toBe("BUTTON");
    expect(within(manage).queryAllByRole("button")).toHaveLength(0);
    expect(within(row("Coolify deploy")).getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("tells two unnamed credentials of one app apart in the accessible name", () => {
    // The motivating case: a deploy token per stage, neither named. An
    // aria-label of "Manage connection Coolify deploy" on both rebuilds the
    // wall this issue removes, inside the accessibility tree.
    connectionItems.mockReturnValue([
      conn({ id: "c1", config: { baseUrl: "https://staging.example.com" } }),
      conn({ id: "c2", config: { baseUrl: "https://prod.example.com" } }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const names = screen
      .getAllByRole("button", { name: /^Manage connection Coolify deploy/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Manage connection Coolify deploy — staging.example.com",
      "Manage connection Coolify deploy — prod.example.com",
    ]);
  });

  it("falls back to the bound projects when two unnamed credentials point nowhere", () => {
    // No config target on either, so the third discriminator the row shows —
    // who uses it — is what has to reach the accessible name.
    connectionItems.mockReturnValue([
      conn({ id: "c1", usage: BOUND }),
      conn({ id: "c2", usage: { bindings: [] } }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const names = screen
      .getAllByRole("button", { name: /^Manage connection Coolify deploy/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Manage connection Coolify deploy — used by forge-dev Live",
      "Manage connection Coolify deploy",
    ]);
  });

  it("names the bound projects even when two credentials share one endpoint", () => {
    // Same app, same endpoint, neither named: the project chips are the only
    // thing that tells them apart on screen, so they are the only thing that
    // can tell them apart in the name.
    connectionItems.mockReturnValue([
      conn({ id: "c1", config: { baseUrl: "https://deploy.example.com" }, usage: BOUND }),
      conn({ id: "c2", config: { baseUrl: "https://deploy.example.com" }, usage: OTHER_BOUND }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const names = screen
      .getAllByRole("button", { name: /^Manage connection Coolify deploy/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Manage connection Coolify deploy — deploy.example.com — used by forge-dev Live",
      "Manage connection Coolify deploy — deploy.example.com — used by forge-plugin Live",
    ]);
  });

  it("carries a binding's scope and its off marker into the name", () => {
    // One project, one endpoint, two tokens: the chips read "forge-dev Live"
    // and "forge-dev Preview · off", and that word is the whole of what tells
    // the two rows apart.
    const sameProject = (
      stage: "live" | "preview",
      active: boolean,
    ): ConnectionDirectoryItem["usage"] => ({
      bindings: [
        {
          id: `b-${stage}`,
          projectId: "proj-a",
          role: "deploy",
          stages: [stage],
          label: "",
          active,
        },
      ],
    });
    connectionItems.mockReturnValue([
      conn({ id: "c1", config: { baseUrl: "https://deploy.example.com" }, usage: sameProject("live", true) }),
      conn({ id: "c2", config: { baseUrl: "https://deploy.example.com" }, usage: sameProject("preview", false) }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const names = screen
      .getAllByRole("button", { name: /^Manage connection Coolify deploy/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Manage connection Coolify deploy — deploy.example.com — used by forge-dev Live",
      "Manage connection Coolify deploy — deploy.example.com — used by forge-dev Preview (off)",
    ]);
  });

  it("names the app when two credentials of different apps share one name", () => {
    // Both called "Production", in two open sections: the provider pill is the
    // only thing that tells them apart on screen, and `aria-label` replaces the
    // descendants that hold it.
    connectionItems.mockReturnValue([
      conn({ id: "c1", displayName: "Production" }),
      conn({ id: "c2", provider: "github", displayName: "Production" }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    openApp("GitHub");
    const names = screen
      .getAllByRole("button", { name: /^Manage connection Production/ })
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Manage connection Production — Coolify deploy",
      "Manage connection Production — GitHub",
    ]);
  });

  it("announces each token of the row exactly once across the name and the description", () => {
    // The name and the description PARTITION the row: the endpoint and the
    // project chips identify the credential and belong to the name alone, so
    // hearing them again in the description is noise on every focus.
    connectionItems.mockReturnValue([
      conn({ config: { baseUrl: "https://deploy.example.com" }, usage: BOUND }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const manage = manageButton("Coolify deploy");
    expect(manage).toHaveAccessibleName(
      "Manage connection Coolify deploy — deploy.example.com — used by forge-dev Live",
    );
    const description = manage.getAttribute("aria-describedby")
      ?.split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).not.toContain("deploy.example.com");
    expect(description).not.toContain("forge-dev");
    expect(description).toContain("last health: ok");
    expect(description).toContain("Personal");
  });

  it("describes the drawer button with the owner the badge shows", () => {
    connectionItems.mockReturnValue([conn({ ownerType: "org", ownerId: "org-1" })]);
    activeOrg.mockReturnValue(TEAM);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(manageButton("Coolify deploy")).toHaveAccessibleDescription(
      expect.stringContaining("SidCorp"),
    );
  });

  it("describes the drawer button with what the aria-label leaves out", () => {
    // `aria-label` replaces the button's descendants, so without a description
    // the row stops answering "who uses it" and "is it healthy" for exactly the
    // people who cannot read the answer beside the control.
    connectionItems.mockReturnValue([
      conn({ lastHealthStatus: null, lastHealthAt: null, hasSecrets: false }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    const manage = manageButton("Coolify deploy");
    expect(manage).toHaveAccessibleDescription(
      expect.stringContaining("Not used by any project"),
    );
    expect(manage).toHaveAccessibleDescription(expect.stringContaining("never health-checked"));
    expect(manage).toHaveAccessibleDescription(
      expect.stringContaining("no credential stored"),
    );
  });

  it("describes the drawer button with the status its pill renders, not its raw health", () => {
    // The pill is a SIBLING of the button, and it says "Disabled" where the
    // health line still says "last health: ok" — the derived state is the one
    // that answers "can I use this", so it has to reach the description too.
    connectionItems.mockReturnValue([conn({ active: false, lastHealthStatus: "ok" })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(manageButton("Coolify deploy")).toHaveAccessibleDescription(
      expect.stringContaining("Disabled"),
    );
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

  it("offers Enable, not Disable, on a row whose credential is switched off", () => {
    connectionItems.mockReturnValue([conn({ active: false })]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(rowActionNames("Coolify deploy")).toEqual(["Enable", "Remove"]);
  });

  it("opens the edit drawer on THAT connection when its row is clicked", () => {
    connectionItems.mockReturnValue([
      conn({ id: "c1", displayName: "Staging token" }),
      conn({ id: "c2", displayName: "Prod token" }),
    ]);
    render(<IntegrationsScreen />);
    openApp("Coolify deploy");
    expect(screen.queryByTestId("connection-edit-drawer")).toBeNull();
    fireEvent.click(manageButton("Prod token"));
    expect(screen.getByTestId("connection-edit-drawer")).toHaveTextContent("c2");
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

  it("exposes each app as a heading, so the grouping is reachable by heading navigation", () => {
    connectionItems.mockReturnValue([conn(), conn({ id: "c2", provider: "github" })]);
    render(<IntegrationsScreen />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent?.split("\n")[0])).toEqual([
      "Coolify deploy1 connection",
      "GitHub1 connection",
    ]);
    expect(within(headings[0]).getByRole("button", { expanded: false })).toBeInTheDocument();
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
      within(appHeader("Coolify deploy")).getByText("2 connections · 1 needs attention"),
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
