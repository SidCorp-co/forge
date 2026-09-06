// @vitest-environment jsdom
//
// Every assertion here is a state the screen got WRONG on forge-beta on
// 2026-09-06: a name printed twice, "no connections yet" over a scope that was
// merely hiding them, and management buttons offered to a principal the API
// answers 403.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const PERSONAL = { id: "org-personal", name: "Personal", isPersonal: true };
const TEAM = { id: "org-1", name: "SidCorp", isPersonal: false };

describe("IntegrationsScreen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    connectionItems.mockReturnValue([]);
    activeOrg.mockReturnValue(PERSONAL);
    orgs.mockReturnValue([{ id: "org-1", name: "SidCorp", role: "member" }]);
    canManage.mockReturnValue(true);
  });

  it("prints the provider label once, not as both the title and a pill", () => {
    connectionItems.mockReturnValue([conn()]);
    render(<IntegrationsScreen />);
    expect(screen.getAllByText("Coolify deploy")).toHaveLength(1);
  });

  it("keeps the provider pill when the connection carries a name of its own", () => {
    connectionItems.mockReturnValue([conn({ displayName: "Prod deploy token" })]);
    render(<IntegrationsScreen />);
    expect(screen.getByText("Prod deploy token")).toBeInTheDocument();
    expect(screen.getByText("Coolify deploy")).toBeInTheDocument();
  });

  it("names the projects using a credential, which is what tells two apart", () => {
    connectionItems.mockReturnValue([
      conn({
        usage: {
          bindings: [
            { id: "b1", projectId: "proj-a", environment: "prod", label: "", active: true },
          ],
        },
      }),
    ]);
    render(<IntegrationsScreen />);
    expect(screen.getByText("forge-dev")).toBeInTheDocument();
  });

  it("shows the endpoint a credential points at", () => {
    connectionItems.mockReturnValue([conn({ config: { baseUrl: "https://deploy.example.com" } })]);
    render(<IntegrationsScreen />);
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
      conn({
        usage: {
          bindings: [
            { id: "b1", projectId: "proj-a", environment: "prod", label: "", active: true },
          ],
        },
      }),
      conn({ id: "conn-2", provider: "sentry" }),
    ]);
    render(<IntegrationsScreen />);
    fireEvent.change(screen.getByLabelText("Search connections"), {
      target: { value: "forge-dev" },
    });
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("offers Remove on the card, behind a confirmation that names the cost", () => {
    connectionItems.mockReturnValue([
      conn({
        usage: {
          bindings: [
            { id: "b1", projectId: "proj-a", environment: "prod", label: "", active: true },
          ],
        },
      }),
    ]);
    render(<IntegrationsScreen />);
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
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disable" })).toBeNull();
    expect(screen.getByText(/only an admin of SidCorp/)).toBeInTheDocument();
  });
});
