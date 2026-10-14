// @vitest-environment jsdom
//
// ISS-1380 — the Sentry settings form, rendered over a stubbed API: the pick list of the
// organization's Sentry projects, the free-text fallback that says why, and a save that stores the
// targets on this project's integration whatever the shared connection's lock.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { boxedInTree } from "@/test-support/flat-rule";
import { SentrySection } from "./section";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const BINDING = "c2e7c0d3-6a4b-4b2f-8a1f-7d3b8e9f5a21";
const NOW = "2026-10-14T00:00:00.000Z";

const LISTED = {
  projects: [
    { organizationSlug: "canawan", slug: "forge-core", name: "Forge Core", platform: "node" },
    { organizationSlug: "canawan", slug: "forge-web", name: "Forge Web", platform: "javascript" },
  ],
  truncated: false,
};

interface Call {
  path: string;
  method: string;
  body: unknown;
}
let calls: Call[];
/** What the stubbed Sentry listing answers: a body, or an ApiError to throw. */
let listing: unknown;
/** Whether an integration is bound at all. */
let bound: boolean;
let boundTargets: unknown[];
/** Whether the connection is org-owned and the caller a plain member of that org. */
let orgLocked: boolean;

const PROJECT_ROW = (): Record<string, unknown> => ({
  id: PROJECT,
  slug: "stub",
  name: "Stub",
  orgId: "63b1b3a0-1f0e-4a77-9f2d-2c5e6a7b8c90",
  orgName: "Stub org",
  orgIsPersonal: false,
  orgRole: orgLocked ? "member" : "owner",
  role: "admin",
});

const binding = () => ({
  id: BINDING,
  connectionId: CONNECTION,
  projectId: PROJECT,
  provider: "sentry",
  role: "service",
  stages: [],
  config: { host: "logs.canawan.com", targets: boundTargets },
  bindingConfig: { targets: boundTargets },
  label: "",
  active: true,
  bindingActive: true,
  connectionActive: true,
  lastHealthStatus: "ok",
  lastHealthAt: NOW,
  breakerOpenedAt: null,
  hasSecrets: true,
  integrationSecretSet: true,
  agentAccess: "none",
  agentPathKind: "direct-mcp",
  createdAt: NOW,
  updatedAt: NOW,
});

const connectionRow = () => ({
  id: CONNECTION,
  ownerType: orgLocked ? "org" : "user",
  ownerId: "u1",
  provider: "sentry",
  displayName: "Sentry",
  config: { host: "logs.canawan.com" },
  active: true,
  lastHealthStatus: "ok",
  lastHealthAt: NOW,
  breakerOpenedAt: null,
  hasSecrets: true,
  createdAt: NOW,
  updatedAt: NOW,
  usage: { bindings: [] },
  access: { reach: "owner", canManage: true, ownerName: "Stub Owner" },
});

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    ...actual,
    apiClient: async (path: string, init?: { method?: string; body?: string }) => {
      const bare = path.split("?")[0] ?? path;
      calls.push({
        path: bare,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      if (bare === `/projects/${PROJECT}/integrations/sentry/projects`) {
        if (listing instanceof Error) throw listing;
        return listing;
      }
      if (bare === `/projects/${PROJECT}/integrations/${BINDING}` && init?.method === "PATCH") {
        return { integration: binding() };
      }
      if (bare === `/projects/${PROJECT}/integrations` && init?.method === "POST") {
        return { integration: binding(), integrationSecret: "whsec_x", health: null };
      }
      if (bare === `/projects/${PROJECT}/integrations`) return { items: bound ? [binding()] : [] };
      if (bare === "/integration-connections") return { items: [connectionRow()] };
      if (bare === "/projects") return [PROJECT_ROW()];
      return { items: [], bindings: [], truncated: false };
    },
  };
});
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: [] }),
  useProjects: () => ({ data: [PROJECT_ROW()] }),
  useProject: () => ({ data: PROJECT_ROW() }),
  useUpdateProject: () => ({ mutate: () => {}, isPending: false, isError: false, error: null }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

let queries: QueryClient;
const mount = () =>
  render(
    <QueryClientProvider client={queries}>
      <SentrySection projectId={PROJECT} />
    </QueryClientProvider>,
  );

async function settled() {
  await waitFor(() => expect(queries.isFetching()).toBe(0));
}

const saved = () =>
  calls.filter((c) => c.method === "PATCH" || (c.method === "POST" && !c.path.endsWith("/projects")));

/** The one save the form made, as sent. */
function theSave(): { config: Record<string, unknown>; secrets?: unknown } {
  const only = saved();
  if (only.length !== 1) throw new Error(`expected one save, the form made ${only.length}`);
  return (only[0] as Call).body as { config: Record<string, unknown>; secrets?: unknown };
}

beforeEach(() => {
  calls = [];
  listing = LISTED;
  bound = true;
  boundTargets = [{ label: "core", organizationSlug: "canawan", projectSlug: "forge-core" }];
  orgLocked = false;
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(cleanup);

describe("the pick list", () => {
  it("offers the organization's Sentry projects for a target, read through the stored credential", async () => {
    mount();
    await settled();

    const select = await screen.findByLabelText("Sentry project for target 1");
    const offered = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(offered.join(" | ")).toContain("Forge Web — canawan/forge-web · javascript");
    expect(
      calls.find((c) => c.path.endsWith("/sentry/projects"))?.body,
      "the listing is asked for with the integration, so the token never reaches the browser",
    ).toEqual({ integrationId: BINDING });
  });

  it("fills the organization and project slugs from the pick and names an unlabelled row after it", async () => {
    boundTargets = [];
    mount();
    const select = await screen.findByLabelText("Sentry project for target 1");

    fireEvent.change(select, { target: { value: "canawan/forge-web" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(theSave()).toEqual({
      config: {
        targets: [{ label: "forge-web", organizationSlug: "canawan", projectSlug: "forge-web" }],
      },
    });
  });

  it("draws no box", async () => {
    const { container } = mount();
    await screen.findByLabelText("Sentry project for target 1");

    expect(boxedInTree(container)).toEqual([]);
  });
});

describe("when the list cannot be read", () => {
  it("says why and keeps free-text slugs", async () => {
    boundTargets = [];
    listing = new ApiError(
      424,
      "sentry: GET https://logs.canawan.com/api/0/organizations/ — the Sentry auth token was rejected",
      "SENTRY_REFUSED",
    );
    mount();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Could not list Sentry projects: sentry: GET https://logs.canawan.com/api/0/organizations/ — the Sentry auth token was rejected",
    );
    expect(screen.getByLabelText("Organization slug")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Sentry project for target/)).toBeNull();
  });

  it("keeps a target whose project the list does not hold as typed slugs", async () => {
    boundTargets = [{ label: "legacy", organizationSlug: "canawan", projectSlug: "not-listed" }];
    mount();
    await settled();

    expect(await screen.findByDisplayValue("not-listed")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Sentry project for target/)).toBeNull();
  });

  it("lets a typed slug the list does not hold be replaced by a pick, keeping the row's other fields", async () => {
    boundTargets = [
      {
        label: "legacy",
        organizationSlug: "canawan",
        projectSlug: "not-listed",
        environment: "prod",
        notes: "old shop",
      },
    ];
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Pick from the list instead" }));

    fireEvent.change(await screen.findByLabelText("Sentry project for target 1"), {
      target: { value: "canawan/forge-web" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(theSave().config.targets).toEqual([
      {
        label: "legacy",
        organizationSlug: "canawan",
        projectSlug: "forge-web",
        environment: "prod",
        notes: "old shop",
      },
    ]);
  });

  it("says when Sentry held more than the list carries", async () => {
    listing = { ...LISTED, truncated: true };
    mount();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "more projects than this list shows",
    );
  });
});

describe("before an integration exists", () => {
  it("reads the list only once the host and token are typed and the person asks", async () => {
    bound = false;
    mount();
    await settled();
    expect(calls.some((c) => c.path.endsWith("/sentry/projects"))).toBe(false);
    const load = screen.getByRole("button", { name: "Load projects from Sentry" });
    expect(load).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("logs.canawan.com"), {
      target: { value: "logs.canawan.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("sntryu_…"), {
      target: { value: "sntryu_a_token_value" },
    });
    fireEvent.click(load);

    await screen.findByLabelText("Sentry project for target 1");
    expect(calls.find((c) => c.path.endsWith("/sentry/projects"))?.body).toEqual({
      host: "logs.canawan.com",
      authToken: "sntryu_a_token_value",
    });
  });
});

describe("editing the saved host or token", () => {
  it("says the list is still read with the saved ones, and stops saying so once it is saved", async () => {
    mount();
    await screen.findByLabelText("Sentry project for target 1");
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.change(screen.getByPlaceholderText("logs.canawan.com"), {
      target: { value: "sentry.example.com" },
    });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "read with the host and token already saved",
    );
  });

  it("reads the list again after a save", async () => {
    mount();
    await screen.findByLabelText("Sentry project for target 1");
    const before = calls.filter((c) => c.path.endsWith("/sentry/projects")).length;

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith("/sentry/projects")).length).toBeGreaterThan(before),
    );
  });
});

describe("asking for the list again", () => {
  it("reads it again on a second press with the credential unchanged, after a first answer that failed", async () => {
    bound = false;
    listing = new ApiError(424, "sentry: Sentry answered HTTP 503", "SENTRY_REFUSED");
    mount();
    await settled();
    fireEvent.change(screen.getByPlaceholderText("logs.canawan.com"), {
      target: { value: "logs.canawan.com" },
    });
    fireEvent.change(screen.getByPlaceholderText("sntryu_…"), {
      target: { value: "sntryu_a_token_value" },
    });
    const load = screen.getByRole("button", { name: "Load projects from Sentry" });

    fireEvent.click(load);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Sentry answered HTTP 503"),
    );
    listing = LISTED;
    fireEvent.click(load);

    await screen.findByLabelText("Sentry project for target 1");
    expect(calls.filter((c) => c.path.endsWith("/sentry/projects"))).toHaveLength(2);
  });
});

describe("saving", () => {
  it("sends this project's targets alone when the host is unchanged", async () => {
    mount();
    await screen.findByLabelText("Sentry project for target 1");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(theSave()).toEqual({ config: { targets: boundTargets } });
  });

  it("lets a project admin save their targets while the connection's host and token are locked to org admins", async () => {
    orgLocked = true;
    mount();
    await screen.findByLabelText("Sentry project for target 1");

    expect(screen.getByPlaceholderText("logs.canawan.com")).toBeDisabled();
    expect(screen.getByPlaceholderText("•••••••• (unchanged)")).toBeDisabled();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeEnabled();

    fireEvent.click(save);

    await waitFor(() => expect(saved()).toHaveLength(1));
    const body = theSave();
    expect(
      Object.keys(body.config),
      "a connection-tier key would make the server ask for an org admin",
    ).toEqual(["targets"]);
    expect(body.secrets).toBeUndefined();
  });

  it("sends the host as well when it was edited by someone who may", async () => {
    mount();
    await screen.findByLabelText("Sentry project for target 1");

    fireEvent.change(screen.getByPlaceholderText("logs.canawan.com"), {
      target: { value: "sentry.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saved()).toHaveLength(1));
    expect(theSave().config.host).toBe("sentry.example.com");
  });
});
