// @vitest-environment jsdom
//
// The App-manifest handshake is the whole reason this section exists, and it is
// the half no type checks: GitHub reads `manifest` from a top-level form POST
// and the callback authenticates on a cookie that only a real navigation sends.
// A `fetch` here would resolve, log nothing, and connect nobody.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../types";
import { GitHubSection } from "./github-section";

expect.extend(matchers);
afterEach(cleanup);

const connectMutate = vi.fn();
const listItems = vi.fn<() => IntegrationSummary[]>();

vi.mock("../hooks", () => ({
  useIntegrationsList: () => ({ data: { items: listItems() } }),
  useGitHubConnect: () => ({ mutateAsync: connectMutate, isPending: false, isError: false, data: null }),
  useDeleteProviderIntegration: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useUpdateProviderIntegration: () => ({ mutate: vi.fn() }),
  useUpdateConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useOrgConnectionLocked: () => false,
}));

const START = {
  postUrl: "https://github.com/organizations/SidCorp-co/settings/apps/new",
  state: "signed.state.value",
  manifest: { name: "Forge — codemap", default_permissions: { issues: "write" } },
};

function binding(over: Partial<IntegrationSummary> = {}): IntegrationSummary {
  return {
    id: "bind-1",
    connectionId: "conn-1",
    projectId: "proj-1",
    provider: "github",
    environment: "prod",
    config: { owner: "SidCorp-co", repo: "codemap" },
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
    connectMutate.mockResolvedValue(START);
    submit = vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(() => {});
  });

  afterEach(() => submit.mockRestore());

  it("hands GitHub the manifest as a form POST carrying the signed state", async () => {
    render(<GitHubSection projectId="proj-1" />);
    fireEvent.change(screen.getByLabelText("Organization"), {
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

  it("passes a blank organization as undefined, so the App lands on the personal account", async () => {
    render(<GitHubSection projectId="proj-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Create GitHub App" }));

    await waitFor(() => expect(connectMutate).toHaveBeenCalled());
    expect(connectMutate).toHaveBeenCalledWith({ org: undefined, environment: "prod" });
  });

  it("shows the connected repository instead of the connect form once a binding exists", () => {
    listItems.mockReturnValue([binding()]);
    render(<GitHubSection projectId="proj-1" />);

    expect(screen.queryByRole("button", { name: "Create GitHub App" })).toBeNull();
    expect(screen.getByRole("link", { name: "SidCorp-co/codemap" })).toHaveAttribute(
      "href",
      "https://github.com/SidCorp-co/codemap",
    );
  });

  it("does not claim a repository the binding never recorded", () => {
    listItems.mockReturnValue([binding({ config: {} })]);
    render(<GitHubSection projectId="proj-1" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/no repository recorded yet/)).toBeInTheDocument();
  });
});
