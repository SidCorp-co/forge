// @vitest-environment jsdom
//
// ISS-1216 criterion 12 — the Connections directory over a credential another person minted and
// the caller reaches only because a project they administer binds it. Rendered, because what is
// claimed is what a person reads on the row: whose it is, that it is theirs to look at and not to
// change, and which space it sits in.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConnectionDirectoryItem } from "@forge/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEAM = { id: "org-team", name: "Sidcorp", isPersonal: false, role: "owner" };
const PERSONAL = { id: "org-me", name: "Me", isPersonal: true, role: "owner" };
const PROJECT_IN_TEAM = "project-in-team";

let connections: ConnectionDirectoryItem[] = [];
let activeOrg = TEAM;

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
  useActiveOrg: () => ({ activeOrg, orgs: [PERSONAL, TEAM] }),
}));
vi.mock("@/features/orgs/hooks", () => ({ useOrgs: () => ({ data: [PERSONAL, TEAM] }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({
    data: [{ id: PROJECT_IN_TEAM, name: "forge-dev", orgId: TEAM.id }],
  }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { IntegrationsScreen } = await import("./integrations-screen");

expect.extend(matchers);

function item(over: Partial<ConnectionDirectoryItem> = {}): ConnectionDirectoryItem {
  return {
    id: "c1",
    ownerType: "user",
    ownerId: "someone-else",
    provider: "github",
    displayName: "Forge GitHub App",
    config: {},
    active: true,
    lastHealthStatus: "ok",
    lastHealthAt: "2026-09-20T00:00:00.000Z",
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    usage: {
      bindings: [
        { id: "b1", projectId: PROJECT_IN_TEAM, role: "service", stages: [], label: "", active: true },
      ],
    },
    access: { reach: "binding", canManage: false },
    ...over,
  };
}

function mount() {
  window.localStorage.setItem("web-v2:integrations-open-apps", JSON.stringify(["github"]));
  render(
    <QueryClientProvider client={new QueryClient()}>
      <IntegrationsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  activeOrg = TEAM;
  connections = [item()];
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("a credential reached only through a binding", () => {
  it("is listed in the space of the org whose project binds it, as another user's and not Personal", async () => {
    mount();

    expect(await screen.findByText("Forge GitHub App")).toBeInTheDocument();
    expect(screen.getByText("Another user")).toBeInTheDocument();
    expect(screen.queryByText("Personal")).toBeNull();
  });

  it("says who may change it, and offers no Disable or Remove", async () => {
    mount();

    expect(await screen.findByText(/only its owner can change this credential/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^disable$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
  });

  it("is not listed in a personal space, where only the caller's own credentials are", () => {
    activeOrg = PERSONAL;

    mount();

    expect(screen.queryByText("Forge GitHub App")).toBeNull();
  });

  it("leaves a credential the caller owns with its controls", async () => {
    connections = [item({ ownerId: "me", access: { reach: "owner", canManage: true } })];
    activeOrg = PERSONAL;

    mount();

    expect(await screen.findByText("Personal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^disable$/i })).toBeInTheDocument();
  });
});
