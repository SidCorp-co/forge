// @vitest-environment jsdom
//
// ISS-1262 finding 6, read off the page a person gets: every provider's section and connection form,
// rendered over a stubbed connection (no live provider), draws no bordered or rounded container.
// settings-flat.test.ts reads the same rule off the source; this one is what catches a box built from
// a class a source read cannot see, such as one a primitive adds.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boxedInTree } from "@/test-support/flat-rule";
import { PROVIDER_MODULES } from "./providers/registry";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const NOW = "2026-10-14T00:00:00.000Z";

/** The provider whose bound integration the stubbed API answers with. */
let provider = "coolify";

function binding(stage: "preview" | "live") {
  return {
    id: `${CONNECTION}-${stage}`,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider,
    role: provider === "coolify" ? "deploy" : "service",
    stages: provider === "coolify" ? [stage] : [],
    config: {
      baseUrl: "https://stub.example.com",
      host: "https://sentry.example.com",
      region: "us",
      mode: "read",
      targets: [{ label: "web", resourceUuid: "abc123" }],
    },
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: "ok",
    lastHealthAt: NOW,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "off",
    agentPathKind: "none",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const CONNECTION_ROW = () => ({
  id: CONNECTION,
  ownerType: "user",
  ownerId: "u1",
  provider,
  displayName: "Stub connection",
  config: { baseUrl: "https://stub.example.com" },
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

const PROJECT_ROW = {
  id: PROJECT,
  slug: "stub",
  name: "Stub",
  orgId: "63b1b3a0-1f0e-4a77-9f2d-2c5e6a7b8c90",
  orgName: "Stub org",
  orgIsPersonal: false,
  orgRole: "owner",
  role: "owner",
};

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    ...actual,
    apiClient: async (path: string) => {
      const bare = path.split("?")[0] ?? path;
      if (bare === `/projects/${PROJECT}/integrations`) return { items: [binding("preview"), binding("live")] };
      if (bare === "/integration-connections") return { items: [CONNECTION_ROW()] };
      if (bare === "/projects") return [PROJECT_ROW];
      if (bare === `/projects/${PROJECT}`) return { ...PROJECT_ROW, agentConfig: {} };
      return { items: [], bindings: [], applications: [], rooms: [], targets: [], repositories: [], truncated: false };
    },
  };
});
vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: [] }),
  useProjects: () => ({ data: [PROJECT_ROW] }),
  useProject: () => ({ data: PROJECT_ROW }),
  useUpdateProject: () => ({ mutate: () => {}, isPending: false, isError: false, error: null }),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

function wrap(node: React.ReactNode) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  provider = "coolify";
});
afterEach(cleanup);

const WITH_SECTION = PROVIDER_MODULES.filter((m) => m.section !== null);
const WITH_CONNECTION_FORM = PROVIDER_MODULES.filter((m) => m.connectionSection !== null);

describe("each provider's section, over a stubbed connection, draws no box", () => {
  it.each(WITH_SECTION.map((m) => m.provider))("%s", async (name) => {
    provider = name;
    const module = PROVIDER_MODULES.find((m) => m.provider === name);
    const { default: Section } = await (module?.section as NonNullable<typeof module.section>)();
    const { container } = render(wrap(<Section projectId={PROJECT} />));
    // The stubbed connection is what the section draws its form from: wait for something more than its skeleton.
    await waitFor(() => expect(container.querySelectorAll("input, textarea, select, button").length).toBeGreaterThan(1));
    expect(boxedInTree(container)).toEqual([]);
  });
});

describe("each provider's connection form, over a stubbed connection, draws no box", () => {
  it.each(WITH_CONNECTION_FORM.map((m) => m.provider))("%s", async (name) => {
    provider = name;
    const module = PROVIDER_MODULES.find((m) => m.provider === name);
    const { default: Form } = await (module?.connectionSection as NonNullable<typeof module.connectionSection>)();
    const { container } = render(
      wrap(<Form connection={{ id: CONNECTION, config: { baseUrl: "https://stub.example.com" } }} canManage />),
    );
    await waitFor(() => expect(container.children.length).toBeGreaterThan(0));
    expect(boxedInTree(container)).toEqual([]);
  });
});

describe("the connection drawer, over a stubbed connection, draws no box", () => {
  it("shows its remove confirmation as a ruled row", async () => {
    const { ConnectionEditDrawer } = await import("./components/connection-edit-drawer");
    render(wrap(<ConnectionEditDrawer connection={CONNECTION_ROW() as never} onClose={() => {}} />));
    fireEvent.click(await screen.findByRole("button", { name: /Remove/ }));
    await screen.findByText(/The connection stays listed as Disabled/);
    expect(boxedInTree(document.body)).toEqual([]);
  });
});
