// @vitest-environment jsdom
//
// ISS-50 — the GitLab section refuses a project path GitLab could not have before anything is sent,
// creates the binding in the shape core reads (provider `gitlab`, `secrets.token`,
// `config.projectPath`/`baseUrl`), and once bound says where the webhook goes without inventing a
// secret it cannot read.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationSummary } from "../../types";

expect.extend(matchers);

let items: IntegrationSummary[] = [];
const create = { mutate: vi.fn(), mutateAsync: vi.fn(async () => ({})), isPending: false };
const pending = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const rotate = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(async () => ({ integrationSecret: "whsec_new_token_0001" })),
  isPending: false,
};

vi.mock("../../hooks", () => ({
  useIntegrationsList: () => ({ data: { items } }),
  useCreateProviderIntegration: () => create,
  useUpdateProviderIntegration: () => pending,
  useDeleteProviderIntegration: () => pending,
  useTestIntegration: () => pending,
  useRotateIntegrationSecret: () => rotate,
  useIsOrgAdmin: () => true,
  useOrgConnectionLocked: () => false,
}));
vi.mock("@/features/projects/hooks", () => ({ useProject: () => ({ data: { slug: "autoflow" } }) }));
vi.mock("../../components/agent-access-control", () => ({
  AGENT_ACCESS_CLOSED: "closed",
  AgentAccessChoice: () => null,
  AgentAccessControl: () => null,
  agentAccessBody: () => ({}),
  agentAccessDeniedReason: () => undefined,
  mayWriteAgentAccess: () => true,
}));
vi.mock("../../components/connection-owner-field", () => ({ ConnectionOwnerField: () => null }));
vi.mock("../../components/integration-enabled-control", () => ({
  IntegrationEnabledControl: () => null,
}));

const { GitlabSection, GITLAB_PROJECT_PATH } = await import("./section");
const { gitlab } = await import("./index");

function binding(config: Record<string, unknown>): IntegrationSummary {
  return {
    id: "b1",
    connectionId: "c1",
    projectId: "p1",
    provider: "gitlab",
    role: "service",
    config,
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
    revision: 1,
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
  } as IntegrationSummary;
}

function fill(token: string, path: string) {
  fireEvent.change(screen.getByPlaceholderText("glpat-…"), { target: { value: token } });
  fireEvent.change(screen.getByPlaceholderText("my-group/my-project"), { target: { value: path } });
}

afterEach(() => {
  cleanup();
  items = [];
  vi.clearAllMocks();
});

describe("GitLab section — creating the binding", () => {
  it("refuses a project path that is not group/project, by name, and sends nothing", async () => {
    render(<GitlabSection projectId="p1" />);
    fill("glpat-abcdefgh", "just-a-project");
    fireEvent.click(screen.getByRole("button", { name: "Create integration" }));
    expect(await screen.findByText(/"just-a-project" is not a GitLab project path/)).toBeInTheDocument();
    expect(create.mutateAsync).not.toHaveBeenCalled();
  });

  it("creates provider gitlab with the token as a secret and the path and base URL as config", async () => {
    render(<GitlabSection projectId="p1" />);
    fill("glpat-abcdefgh", "acme/sub/web");
    fireEvent.click(screen.getByRole("button", { name: "Create integration" }));
    await waitFor(() => expect(create.mutateAsync).toHaveBeenCalledTimes(1));
    expect(create.mutateAsync).toHaveBeenCalledWith({
      provider: "gitlab",
      role: "service",
      config: { baseUrl: "https://gitlab.com", projectPath: "acme/sub/web" },
      secrets: { token: "glpat-abcdefgh" },
    });
  });

  it("will not create with a token under eight characters", () => {
    render(<GitlabSection projectId="p1" />);
    fill("glpat-1", "acme/web");
    expect(screen.getByRole("button", { name: "Create integration" })).toBeDisabled();
    fill("glpat-12", "acme/web");
    expect(screen.getByRole("button", { name: "Create integration" })).toBeEnabled();
  });

  it("accepts nested groups and refuses a leading dash or an empty segment", () => {
    expect(GITLAB_PROJECT_PATH.test("acme/web")).toBe(true);
    expect(GITLAB_PROJECT_PATH.test("acme/sub.group/web_app-2")).toBe(true);
    expect(GITLAB_PROJECT_PATH.test("acme/-web")).toBe(false);
    expect(GITLAB_PROJECT_PATH.test("acme//web")).toBe(false);
    expect(GITLAB_PROJECT_PATH.test("acme/web/")).toBe(false);
  });
});

describe("GitLab section — once bound", () => {
  it("names the webhook URL by project slug, the three events, and no secret it cannot read", () => {
    items = [binding({ baseUrl: "https://gitlab.com", projectPath: "acme/web" })];
    render(<GitlabSection projectId="p1" />);
    const hook = screen.getByTestId("gitlab-webhook");
    expect(hook).toHaveTextContent(/\/api\/webhooks\/in\/autoflow/);
    expect(hook).toHaveTextContent("Push events, Merge request events, Pipeline events");
    expect(hook).toHaveTextContent("Forge cannot show a token it already holds");
    expect(hook).not.toHaveTextContent("whsec_");
  });

  it("shows a generated secret token once it is minted", async () => {
    items = [binding({ projectPath: "acme/web" })];
    render(<GitlabSection projectId="p1" />);
    fireEvent.click(screen.getByRole("button", { name: "Generate secret token" }));
    expect(await screen.findByText("whsec_new_token_0001")).toBeInTheDocument();
    expect(rotate.mutateAsync).toHaveBeenCalledWith("b1");
  });
});

describe("GitLab module", () => {
  it("names its target host/path, defaulting the host to gitlab.com", () => {
    expect(gitlab.target({ projectPath: "acme/web" })).toBe("gitlab.com/acme/web");
    expect(gitlab.target({ baseUrl: "https://git.acme.io/", projectPath: "acme/web" })).toBe("git.acme.io/acme/web");
    expect(gitlab.target({})).toBeNull();
  });
});
