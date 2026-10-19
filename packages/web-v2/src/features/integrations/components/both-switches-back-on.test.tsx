// @vitest-environment jsdom
//
// ISS-1421 r12 — a binding turned off at both tiers, walked back on in its drawer: Enable credential,
// then Enabled. The drawer must read the state it was just told to set, without a reload.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const BINDING = "c2e7a0d3-6a4b-4b2f-8a1f-7d3b8e9f5a21";
const NOW = "2026-10-14T00:00:00.000Z";

let provider = "sentry";
const stored = { binding: false, connection: false };
/** A list read that does not land after a write: the drawer must still read what the write answered. */
let listFailsAfterWrite = false;
let written = false;
/** A list read taken before a write and answered after it, with the state from before. */
let holdNextRead: Promise<void> | null = null;

function row() {
  return {
    id: BINDING,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider,
    role: "service",
    stages: [],
    config: { host: "sentry.example.com" },
    bindingConfig: {},
    label: "",
    active: stored.binding && stored.connection,
    bindingActive: stored.binding,
    connectionActive: stored.connection,
    lastHealthStatus: "ok",
    lastHealthAt: NOW,
    breakerOpenedAt: null,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "all",
    agentPathKind: "direct-mcp",
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
    apiClient: async (path: string, init?: { method?: string; body?: string }) => {
      const bare = path.split("?")[0] ?? path;
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(init.body) as { active?: boolean }) : {};
      if (method === "PATCH" && bare === `/integration-connections/${CONNECTION}`) {
        if (body.active !== undefined) stored.connection = body.active;
        written = true;
        return { connection: { id: CONNECTION, provider, active: stored.connection } };
      }
      if (method === "PATCH" && bare === `/projects/${PROJECT}/integrations/${BINDING}`) {
        if (body.active !== undefined) stored.binding = body.active;
        written = true;
        return { integration: row() };
      }
      if (bare === `/projects/${PROJECT}/integrations`) {
        if (listFailsAfterWrite && written) throw new actual.ApiError(503, "Service unavailable.");
        const before = row();
        const held = holdNextRead;
        holdNextRead = null;
        if (held) await held;
        return { items: [before], bindings: [before] };
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
  stored.binding = false;
  stored.connection = false;
  written = false;
  holdNextRead = null;
  queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
});
afterEach(cleanup);

async function settled(): Promise<void> {
  await waitFor(() => {
    expect(queries.isFetching()).toBe(0);
    expect(queries.isMutating()).toBe(0);
    expect(document.querySelector(".skeleton")).toBeNull();
  });
}

describe("a binding off at both tiers, walked back on in its drawer", () => {
  it.each([
    ["sentry", false],
    ["postman", false],
    ["sentry", true],
    ["postman", true],
  ])("%s reads on without a reload (list read refused after each write: %s)", async (name, fails) => {
    provider = name;
    listFailsAfterWrite = fails;
    render(
      <QueryClientProvider client={queries}>
        <ConnectionDetailDrawer
          projectId={PROJECT}
          card={{ key: name, status: "connected", meta: {} } as never}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    await settled();
    const enabled = () => screen.getByRole("switch", { name: "Enabled for this project" });
    expect(enabled()).toHaveAttribute("aria-checked", "false");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enable credential" }));
    });
    await settled();
    expect(screen.queryByRole("button", { name: "Enable credential" })).toBeNull();

    await act(async () => {
      fireEvent.click(enabled());
    });
    await settled();
    expect(stored).toEqual({ binding: true, connection: true });
    expect(enabled()).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByText("Turned off")).toBeNull();
  });

  it.each(["sentry", "postman"])(
    "%s: a list read taken before Enabled and answered after it does not undo it",
    async (name) => {
      provider = name;
      listFailsAfterWrite = false;
      render(
        <QueryClientProvider client={queries}>
          <ConnectionDetailDrawer
            projectId={PROJECT}
            card={{ key: name, status: "connected", meta: {} } as never}
            onClose={() => {}}
          />
        </QueryClientProvider>,
      );
      await settled();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Enable credential" }));
      });
      await settled();

      let release = () => {};
      holdNextRead = new Promise<void>((resolve) => {
        release = resolve;
      });
      void queries.refetchQueries({ queryKey: ["integrations", "list", PROJECT] });
      const enabled = () => screen.getByRole("switch", { name: "Enabled for this project" });
      await act(async () => {
        fireEvent.click(enabled());
      });
      await waitFor(() => expect(stored.binding).toBe(true));
      await act(async () => {
        release();
      });
      await settled();
      expect(enabled()).toHaveAttribute("aria-checked", "true");
      expect(screen.queryByText("Turned off")).toBeNull();
    },
  );
});
