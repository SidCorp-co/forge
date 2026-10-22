// @vitest-environment jsdom
//
// ISS-1421 r8, criterion 128 — judge-40 saw the Coolify and Postman drawers show "Agents on this
// project may use this" twice: once in the provider's own section, once more from the drawer.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_MODULES } from "../providers/registry";
import { GRANT_LABEL } from "./agent-access-control";
import { BindingsList, ConnectionDetailDrawer } from "./connection-detail-drawer";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const NOW = "2026-10-14T00:00:00.000Z";

let provider = "coolify";
let served: string[] = [];
/** The providers whose binding here is a deploy binding; the others are service bindings. */
let deployTo: string[] = ["coolify"];

function binding(stage: "preview" | "live") {
  return {
    id: `${CONNECTION}-${stage}`,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider,
    role: deployTo.includes(provider) ? "deploy" : "service",
    stages: deployTo.includes(provider) ? [stage] : [],
    config: { baseUrl: "https://stub.example.com", host: "https://sentry.example.com" },
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
    agentPathKind: "core-mediated",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

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
      served.push(bare);
      if (bare === `/projects/${PROJECT}/integrations`) {
        // One binding per provider, as a drawer opened from one row shows; Coolify's two are its stages.
        return { items: provider === "coolify" ? [binding("preview"), binding("live")] : [binding("live")] };
      }
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

let queries: QueryClient;

beforeEach(() => {
  served = [];
  deployTo = ["coolify"];
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(cleanup);

describe("a provider's drawer shows the agents switch once", () => {
  it.each(PROVIDER_MODULES.filter((m) => m.section !== null).map((m) => m.provider))(
    "%s",
    async (name) => {
      provider = name;
      render(
        <QueryClientProvider client={queries}>
          <ConnectionDetailDrawer
            projectId={PROJECT}
            card={{ key: name, status: "connected", meta: {} } as never}
            onClose={() => {}}
          />
        </QueryClientProvider>,
      );
      // The section is lazy: count only once its Suspense fallback is gone and every read answered,
      // or a switch the pane draws first is counted before the section's own arrives.
      await waitFor(() => {
        expect(served).toContain(`/projects/${PROJECT}/integrations`);
        expect(queries.isFetching()).toBe(0);
        expect(document.querySelector(".skeleton")).toBeNull();
        expect(screen.getAllByText(GRANT_LABEL).length).toBeGreaterThan(0);
      });
      expect(screen.getAllByText(GRANT_LABEL)).toHaveLength(1);
    },
  );
});

// ISS-1339 r2, judge-98: round 1 took the probe off Shape & release, and the place its gap link
// sent a person had no field for it. Every provider a release reads a probe from that has a drawer
// here is drawn with its live binding's probe; a binding that serves only Preview has none to set.
describe("a live deploy binding's drawer offers its verify probe", () => {
  function drawDrawer(name: string, stage: "preview" | "live") {
    provider = name;
    deployTo = [name];
    render(
      <QueryClientProvider client={queries}>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: `${name}:${stage}`, status: "connected", meta: { capabilities: { canDeploy: true } } } as never}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
  }

  it.each(["coolify", "epodsystem"])("%s, at Live", async (name) => {
    drawDrawer(name, "live");
    await waitFor(() => {
      expect(queries.isFetching()).toBe(0);
      expect(screen.getByText("Verify probe")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Probe 1 URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Probe 1 commit field")).toBeInTheDocument();
  });

  it("not on a binding that serves only Preview", async () => {
    drawDrawer("coolify", "preview");
    await waitFor(() => {
      expect(served).toContain(`/projects/${PROJECT}/integrations`);
      expect(queries.isFetching()).toBe(0);
      expect(document.querySelector(".skeleton")).toBeNull();
    });
    expect(screen.queryByText("Verify probe")).toBeNull();
  });
});

// ISS-1421 r23, judge-94 on 224: an org member's list named a project they cannot open by its id.
describe("a project's list of the projects a connection is bound to", () => {
  it("names a project the reader cannot open in words, never by its id", () => {
    const other = { ...binding("live"), id: "b-other", projectId: "9f1c2d3e-0000-4000-8000-000000000001" };
    render(
      <BindingsList
        items={[binding("live"), other] as never}
        projectNames={new Map([[PROJECT, "Stub"]])}
        projectsRead
        currentProjectId={PROJECT}
        currentStage={null}
      />,
    );
    expect(screen.getByText("Stub")).toBeInTheDocument();
    expect(screen.getByText("A project you cannot open")).toBeInTheDocument();
    expect(screen.queryByText(/9f1c2d3e/)).toBeNull();
  });
});
