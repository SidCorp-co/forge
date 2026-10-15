// @vitest-environment jsdom
//
// ISS-1171 — the Connections directory with nothing in it offered no way to add a connection:
// it named the page to go to in prose and left the reader to find it. The empty directory now
// carries the one act that fills it, a link to a project's own Integrations settings in this space.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEAM = { id: "org-team", name: "Acme QA Org", isPersonal: false, role: "owner" };
const OTHER = { id: "org-other", name: "Elsewhere", isPersonal: false, role: "owner" };

type ProjectRow = { id: string; slug: string; name: string; orgId: string; archivedAt: string | null };

let connections: ConnectionDirectoryItem[] = [];
let projects: ProjectRow[] = [];

vi.mock("../hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks")>()),
  useConnections: () => ({
    data: { items: connections },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: TEAM, orgs: [TEAM, OTHER] }),
}));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: [TEAM, OTHER] }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: projects }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { IntegrationsScreen } = await import("./integrations-screen");

expect.extend(matchers);

const row = (over: Partial<ProjectRow>): ProjectRow => ({
  id: "p1",
  slug: "desk",
  name: "Desk",
  orgId: TEAM.id,
  archivedAt: null,
  ...over,
});

function mount() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntegrationsScreen />
    </QueryClientProvider>,
  );
  return within(screen.getByTestId("connections-empty"));
}

beforeEach(() => {
  connections = [];
  projects = [];
});
afterEach(cleanup);

describe("an empty Connections directory", () => {
  it("links the one project in this space to its Integrations settings", () => {
    projects = [row({}), row({ id: "p2", slug: "far", name: "Far", orgId: OTHER.id })];
    const empty = mount();
    expect(empty.getByRole("link", { name: "Add a connection in Desk" })).toHaveAttribute(
      "href",
      "/projects/desk/settings?tab=integrations",
    );
  });

  it("lets the reader pick which of several projects in this space, leaving out archived ones and other spaces'", () => {
    projects = [
      row({}),
      row({ id: "p2", slug: "shop", name: "Shop" }),
      row({ id: "p3", slug: "old", name: "Old", archivedAt: "2026-01-01T00:00:00.000Z" }),
      row({ id: "p4", slug: "far", name: "Far", orgId: OTHER.id }),
    ];
    const empty = mount();
    const picker = empty.getByRole("combobox", { name: "Project to add a connection in" });
    expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Desk", "Shop"]);
    const add = empty.getByRole("link", { name: "Add a connection in this project" });
    expect(add).toHaveAttribute("href", "/projects/desk/settings?tab=integrations");
    fireEvent.change(picker, { target: { value: "shop" } });
    expect(add).toHaveAttribute("href", "/projects/shop/settings?tab=integrations");
  });

  it("offers to create a project where this space has none to add a connection from", () => {
    projects = [row({ orgId: OTHER.id })];
    const empty = mount();
    expect(empty.getByText(/Acme QA Org has no project yet/)).toBeInTheDocument();
    expect(empty.getByRole("link", { name: "Create a project" })).toHaveAttribute("href", "/projects?new=1");
  });

  it("still offers the act where the reader holds connections only in other spaces", () => {
    projects = [row({})];
    connections = [
      {
        id: "c1",
        ownerType: "org",
        ownerId: OTHER.id,
        provider: "github",
        displayName: "Elsewhere App",
        config: {},
        active: true,
        lastHealthStatus: "ok",
        lastHealthAt: null,
        breakerOpenedAt: null,
        hasSecrets: true,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
        usage: { bindings: [] },
        access: { reach: "owner", canManage: true, ownerName: null },
      } as unknown as ConnectionDirectoryItem,
    ];
    const empty = mount();
    expect(empty.getByText("No connections in Acme QA Org")).toBeInTheDocument();
    expect(empty.getByRole("link", { name: "Add a connection in Desk" })).toBeInTheDocument();
  });
});
