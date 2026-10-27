// @vitest-environment jsdom
//
// ISS-1421 r11 — a turned-off binding's agents line says it comes back once Enabled in this drawer
// is switched on. Coolify's drawer had no such switch, so the line named a control nobody could find.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_MODULES } from "../providers/registry";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";
import { ALL_ACTS, ALL_MAY } from "../test-acts";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const NOW = "2026-10-14T00:00:00.000Z";

let provider = "coolify";
let served: string[] = [];

function binding(stage: "preview" | "live") {
  return {
    id: `${CONNECTION}-${stage}`,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider,
    role: provider === "coolify" ? "deploy" : "service",
    stages: provider === "coolify" ? [stage] : [],
    config: { baseUrl: "https://stub.example.com", host: "https://sentry.example.com" },
    bindingConfig: {},
    label: "",
    active: false,
    bindingActive: false,
    connectionActive: true,
    lastHealthStatus: "ok",
    lastHealthAt: NOW,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "all",
    agentPathKind: "core-mediated",
    acts: ALL_ACTS,
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
        return { items: provider === "coolify" ? [binding("preview"), binding("live")] : [binding("live")], may: ALL_MAY };
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
  queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(cleanup);

describe("a turned-off binding's drawer has the switch its agents line names", () => {
  it.each(PROVIDER_MODULES.filter((m) => m.section !== null).map((m) => m.provider))(
    "%s",
    async (name) => {
      provider = name;
      render(
        <QueryClientProvider client={queries}>
          <ConnectionDetailDrawer
            projectId={PROJECT}
            card={{ key: name, status: "connected", configured: true, meta: { bindingId: `${CONNECTION}-${name === "coolify" ? "preview" : "live"}` } } as never}
            onClose={() => {}}
          />
        </QueryClientProvider>,
      );
      await waitFor(() => {
        expect(served).toContain(`/projects/${PROJECT}/integrations`);
        expect(queries.isFetching()).toBe(0);
        expect(document.querySelector(".skeleton")).toBeNull();
        expect(screen.getByText(/once Enabled in this drawer is switched back on/)).toBeInTheDocument();
      });
      expect(screen.getByRole("switch", { name: "Enabled for this project" })).toBeInTheDocument();
    },
  );
});
