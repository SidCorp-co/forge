// @vitest-environment jsdom
//
// Two rules carry this screen. The manifest handshake is a top-level form POST
// because GitHub reads `manifest` from a form and the callback authenticates on
// a cookie only a navigation sends. And an App already connected is REUSED: the
// repository a project uses belongs on its binding, so minting one App per
// project puts the scope in the wrong place and costs a private key each time.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../types";
import { GitHubSection } from "./github-section";

expect.extend(matchers);
afterEach(cleanup);

const connectMutate = vi.fn();
const bindMutate = vi.fn();
const listItems = vi.fn<() => IntegrationSummary[]>();
const connectionItems = vi.fn<() => Array<Record<string, unknown>>>();
const repoData = vi.fn<() => Record<string, unknown> | undefined>();

vi.mock("../hooks", () => ({
  useIntegrationsList: () => ({ data: { items: listItems() } }),
  useConnections: () => ({ data: { items: connectionItems() } }),
  useGitHubRepositories: () => ({ data: repoData(), isLoading: false, isError: false }),
  useBindExistingConnection: () => ({ mutate: bindMutate, isPending: false, isError: false }),
  useGitHubConnect: () => ({
    mutateAsync: connectMutate,
    isPending: false,
    isError: false,
    data: null,
  }),
  useDeleteProviderIntegration: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useUpdateProviderIntegration: () => ({ mutate: vi.fn() }),
  useUpdateConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
}));

vi.mock("./connection-owner-field", () => ({ ConnectionOwnerField: () => null }));

const START = {
  postUrl: "https://github.com/organizations/SidCorp-co/settings/apps/new",
  state: "signed.state.value",
  manifest: { name: "Forge", default_permissions: { issues: "write" } },
};

const REPOS = {
  repositories: [
    {
      installationId: 111,
      account: "SidCorp-co",
      owner: "SidCorp-co",
      repo: "forge",
      fullName: "SidCorp-co/forge",
    },
    {
      installationId: 222,
      account: "other-org",
      owner: "other-org",
      repo: "codemap",
      fullName: "other-org/codemap",
    },
  ],
  truncated: false,
};

function binding(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: "bind-1",
    connectionId: "conn-1",
    projectId: "proj-1",
    provider: "github",
    environment: "prod",
    config: { owner: "SidCorp-co", repo: "forge" },
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: "ok",
    lastHealthAt: null,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: false,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...over,
  } as IntegrationSummary;
}

describe("GitHubSection", () => {
  let submit: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    listItems.mockReturnValue([]);
    connectionItems.mockReturnValue([]);
    repoData.mockReturnValue(REPOS);
    connectMutate.mockResolvedValue(START);
    submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
  });

  afterEach(() => submit.mockRestore());

  it("reuses an App that already exists instead of offering to mint another", () => {
    connectionItems.mockReturnValue([
      { id: "conn-1", provider: "github", active: true, displayName: "GitHub App forge-sidcorp" },
    ]);
    render(<GitHubSection projectId="proj-1" />);

    expect(screen.queryByRole("button", { name: "Create GitHub App" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect repository" })).toBeInTheDocument();
    expect(screen.getByText(/GitHub App forge-sidcorp/)).toBeInTheDocument();
  });

  it("puts the repository AND its installation on the binding, not on a new App", async () => {
    connectionItems.mockReturnValue([{ id: "conn-1", provider: "github", active: true }]);
    render(<GitHubSection projectId="proj-1" />);

    fireEvent.change(screen.getByLabelText("Repository"), {
      target: { value: "other-org/codemap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect repository" }));

    await waitFor(() => expect(bindMutate).toHaveBeenCalledTimes(1));
    expect(bindMutate).toHaveBeenCalledWith({
      id: "conn-1",
      body: {
        projectId: "proj-1",
        environment: "prod",
        config: { owner: "other-org", repo: "codemap", installationId: 222 },
      },
    });
    expect(connectMutate).not.toHaveBeenCalled();
  });

  it("refuses to bind until a repository is chosen", () => {
    connectionItems.mockReturnValue([{ id: "conn-1", provider: "github", active: true }]);
    render(<GitHubSection projectId="proj-1" />);

    expect(screen.getByRole("button", { name: "Connect repository" })).toBeDisabled();
  });

  it("offers the create path only when no App exists", () => {
    render(<GitHubSection projectId="proj-1" />);
    expect(screen.getByRole("button", { name: "Create GitHub App" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use an existing App" })).toBeNull();
  });

  it("hands GitHub the manifest as a form POST carrying the signed state", async () => {
    render(<GitHubSection projectId="proj-1" />);
    fireEvent.change(screen.getByLabelText("GitHub organization"), {
      target: { value: "SidCorp-co" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create GitHub App" }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const form = submit.mock.instances[0] as HTMLFormElement;
    expect(form.method).toBe("post");
    expect(form.action).toBe(`${START.postUrl}?state=signed.state.value`);
    const field = form.querySelector('input[name="manifest"]') as HTMLInputElement;
    expect(JSON.parse(field.value)).toEqual(START.manifest);
  });

  it("shows the connected repository once a binding exists", () => {
    listItems.mockReturnValue([binding()]);
    render(<GitHubSection projectId="proj-1" />);

    expect(screen.queryByRole("button", { name: "Connect repository" })).toBeNull();
    expect(screen.getByRole("link", { name: "SidCorp-co/forge" })).toHaveAttribute(
      "href",
      "https://github.com/SidCorp-co/forge",
    );
  });

  it("says so rather than inventing a repository the binding never recorded", () => {
    listItems.mockReturnValue([binding({ config: {} })]);
    render(<GitHubSection projectId="proj-1" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/no repository recorded yet/)).toBeInTheDocument();
  });
});
