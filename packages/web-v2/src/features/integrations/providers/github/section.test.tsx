// @vitest-environment jsdom
//
// ISS-1115 asked for the state an owner measured on live forge-dev rather than a
// live specimen: a github binding row that survived a Disconnect — `active:
// false`, `config: {}` — which `listBindingsForProject` hands straight back, so
// the component sees a row and no repository. `GITHUB_EMPTY_INACTIVE` is that
// row.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSummary, IntegrationSummary } from "../../types";

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const BINDING = "3f7c1a44-9e52-4d6b-8a21-0b5c9d2e7f61";

const bind = vi.fn();
const update = vi.fn();
const remove = vi.fn();

let items: IntegrationSummary[] = [];
let connections: ConnectionSummary[] = [];

const REPOSITORIES = [
  {
    fullName: "SidCorp-co/forge",
    owner: "SidCorp-co",
    repo: "forge",
    installationId: 159473037,
  },
  {
    fullName: "SidCorp-co/forge-plugin",
    owner: "SidCorp-co",
    repo: "forge-plugin",
    installationId: 159473037,
  },
];

vi.mock("../../hooks", () => ({
  useIntegrationsList: () => ({ data: { items } }),
  useConnections: () => ({ data: { items: connections } }),
  useGitHubRepositories: () => ({
    data: { repositories: REPOSITORIES, truncated: false },
    isLoading: false,
    isError: false,
    error: null,
  }),
  useBindExistingConnection: () => ({ mutate: bind, isPending: false, isError: false, error: null }),
  useUpdateProviderIntegration: () => ({
    mutate: update,
    isPending: false,
    isError: false,
    error: null,
  }),
  useDeleteProviderIntegration: () => ({
    mutate: remove,
    isPending: false,
    isError: false,
    error: null,
  }),
  useGitHubConnect: () => ({ mutateAsync: vi.fn(), isPending: false, isError: false, error: null }),
  useUpdateConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
  useIsOrgAdmin: () => true,
}));

const { GitHubSection } = await import("./section");

expect.extend(matchers);

function binding(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: BINDING,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider: "github",
    role: "service",
    stages: [],
    config: {},
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "none",
    agentPathKind: "core-mediated",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...over,
  } as IntegrationSummary;
}

function connection(over: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: CONNECTION,
    ownerType: "org",
    ownerId: "63b1b3a0-1f0e-4a77-9f2d-2c5e6a7b8c90",
    provider: "github",
    displayName: "SidCorp-co App",
    config: {},
    active: true,
    lastHealthStatus: null,
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
    ...over,
  } as ConnectionSummary;
}

/** The measured state: Disconnect left the row behind, switched off and empty. */
const GITHUB_EMPTY_INACTIVE = binding({ active: false, bindingActive: false, config: {} });

const GITHUB_CONFIGURED = binding({
  config: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
  bindingConfig: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
});

function mount() {
  render(<GitHubSection projectId={PROJECT} />);
}

function picker(): HTMLSelectElement | null {
  return screen.queryByLabelText("Repository") as HTMLSelectElement | null;
}

function choose(fullName: string) {
  const select = picker();
  if (!select) throw new Error("the repository picker did not render");
  fireEvent.change(select, { target: { value: fullName } });
}

beforeEach(() => {
  bind.mockClear();
  update.mockClear();
  remove.mockClear();
  items = [];
  connections = [connection()];
});
afterEach(cleanup);

describe("a github binding that records a repository", () => {
  it("names that repository on the connected card", () => {
    items = [GITHUB_CONFIGURED];

    mount();

    expect(screen.getByText("SidCorp-co/forge")).toBeInTheDocument();
  });

  it("offers a control that reopens the picker, so a repository is changeable in place", () => {
    items = [GITHUB_CONFIGURED];
    mount();

    fireEvent.click(screen.getByRole("button", { name: /change repository/i }));

    expect(picker()).not.toBeNull();
  });

  it("changes the repository by patching that same row, with no `active` field on an active binding", () => {
    items = [GITHUB_CONFIGURED];
    mount();
    fireEvent.click(screen.getByRole("button", { name: /change repository/i }));

    choose("SidCorp-co/forge-plugin");
    fireEvent.click(screen.getByRole("button", { name: /^save repository$/i }));

    expect(bind).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    const [vars] = update.mock.calls[0];
    expect(vars).toEqual({
      id: BINDING,
      body: {
        config: { owner: "SidCorp-co", repo: "forge-plugin", installationId: 159473037 },
      },
    });
    expect(vars.body).not.toHaveProperty("active");
  });
});

describe("a github binding row that records no repository", () => {
  it("renders the picker rather than the connected card when the row is switched off", () => {
    items = [GITHUB_EMPTY_INACTIVE];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("renders the picker when the row is still active", () => {
    items = [binding({ config: {} })];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("renders the picker when owner and repo are present but empty", () => {
    items = [binding({ config: { owner: "", repo: "" } })];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("renders the picker when owner and repo are not strings", () => {
    items = [binding({ config: { owner: 7, repo: false } })];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("patches the surviving row instead of asking for a second one the unique index refuses", () => {
    items = [GITHUB_EMPTY_INACTIVE];
    mount();

    choose("SidCorp-co/forge");
    fireEvent.click(screen.getByRole("button", { name: /^save repository$/i }));

    expect(bind).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].id).toBe(BINDING);
  });

  it("switches the row back on in the same write that gives it a repository", () => {
    items = [GITHUB_EMPTY_INACTIVE];
    mount();

    choose("SidCorp-co/forge");
    fireEvent.click(screen.getByRole("button", { name: /^save repository$/i }));

    expect(update.mock.calls[0][0].body).toEqual({
      config: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
      active: true,
    });
  });

  it("never prints the instruction that names an act which cannot work", () => {
    items = [GITHUB_EMPTY_INACTIVE];

    mount();

    expect(screen.queryByText(/reconnecting this project/i)).toBeNull();
  });
});

describe("a project with no github binding row at all", () => {
  it("renders the picker over the reusable connection", () => {
    items = [];

    mount();

    expect(picker()).not.toBeNull();
  });

  it("still creates the binding through the bind-existing route, with the body it sent before", () => {
    items = [];
    mount();

    choose("SidCorp-co/forge");
    fireEvent.click(screen.getByRole("button", { name: /^connect repository$/i }));

    expect(update).not.toHaveBeenCalled();
    expect(bind).toHaveBeenCalledTimes(1);
    expect(bind.mock.calls[0][0]).toEqual({
      id: CONNECTION,
      body: {
        projectId: PROJECT,
        role: "service",
        config: { owner: "SidCorp-co", repo: "forge", installationId: 159473037 },
        agentAccess: "none",
      },
    });
  });
});
