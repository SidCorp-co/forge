// @vitest-environment jsdom
//
// ISS-1421 r33, judge-136 on criteria 302 and 144: after a provider was removed and connected again the
// tab showed two rows, and Manage on the "Turned off" one opened the binding in use under that header,
// its badge reading the other binding and its Disconnect taking the live one off the project. A row
// opens exactly the binding it shows, and every control in its drawer reads and acts on that one.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LeaveGuardProvider } from "@/design";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";
import { DISCONNECT_FROM_PROJECT } from "./disconnect-from-project";
import { ALL_ACTS, ALL_MAY } from "../test-acts";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const REMOVED = "4762c841-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const IN_USE = "81d3773f-6a4b-4b2f-8a1f-7d3b8e9f5a21";

let provider = "sentry";
const sent: Array<{ method: string; path: string }> = [];

/** The removed binding, switched off over a removed connection, and the newer one in use. */
function bindings() {
  const deploy = provider === "coolify";
  const base = {
    projectId: PROJECT,
    provider,
    role: deploy ? "deploy" : "service",
    stages: deploy ? ["live"] : [],
    bindingConfig: {},
    label: "",
    breakerOpenedAt: null,
    integrationSecretSet: true,
    agentAccess: "all",
    agentPathKind: "direct-mcp",
    acts: ALL_ACTS,
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  return [
    {
      ...base,
      id: REMOVED,
      connectionId: "a1000000-0000-4000-8000-000000000001",
      config: { host: "old-removed.example.test", serverUrl: "https://old-removed.example.test" },
      active: false,
      bindingActive: false,
      connectionActive: false,
      hasSecrets: false,
      lastHealthStatus: null,
      lastHealthAt: null,
      createdAt: "2026-10-01T00:00:00.000Z",
    },
    {
      ...base,
      id: IN_USE,
      connectionId: "a2000000-0000-4000-8000-000000000002",
      config: { host: "new-in-use.example.test", serverUrl: "https://new-in-use.example.test" },
      active: true,
      bindingActive: true,
      connectionActive: true,
      hasSecrets: true,
      lastHealthStatus: "error",
      lastHealthAt: "2026-10-26T00:00:00.000Z",
      createdAt: "2026-10-20T00:00:00.000Z",
    },
  ];
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
    apiClient: async (path: string, init?: { method?: string }) => {
      const bare = path.split("?")[0] ?? path;
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        sent.push({ method, path: bare });
        return { ok: true };
      }
      if (bare === `/projects/${PROJECT}/integrations`) {
        return { items: bindings(), bindings: bindings(), may: ALL_MAY };
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
  sent.length = 0;
  queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
});
afterEach(cleanup);

/** The row's card as core's status read builds it for two bindings of one provider. */
function card(bindingId: string) {
  const deploy = provider === "coolify";
  const removed = bindingId === REMOVED;
  return {
    key: `${provider}:${deploy ? "live" : "service"}:${bindingId}`,
    label: provider,
    status: removed ? "disabled" : "error",
    detail: "",
    lastSyncAt: null,
    configured: true,
    meta: {
      bindingId,
      lastHealthStatus: removed ? null : "error",
      ...(deploy ? { capabilities: { canDeploy: true } } : {}),
    },
  };
}

async function open(bindingId: string): Promise<void> {
  render(
    <QueryClientProvider client={queries}>
      <LeaveGuardProvider>
        <ConnectionDetailDrawer projectId={PROJECT} card={card(bindingId) as never} onClose={() => {}} />
      </LeaveGuardProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(queries.isFetching()).toBe(0);
    expect(document.querySelector(".skeleton")).toBeNull();
  });
}

const enabledSwitch = () => screen.getByRole("switch", { name: /Enabled for this project/ });

const PROVIDERS = ["sentry", "rocketchat", "postman", "google", "coolify"];

describe("the turned-off row of a provider removed and connected again", () => {
  it.each(PROVIDERS)("%s: its drawer reads the switched-off binding, header and badge alike", async (name) => {
    provider = name;
    await open(REMOVED);
    await waitFor(() => expect(screen.getAllByText("Turned off").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText("Last check failed")).toBeNull();
    expect(enabledSwitch()).not.toBeChecked();
  });

  it.each(PROVIDERS)("%s: it offers no Disconnect from this project", async (name) => {
    provider = name;
    await open(REMOVED);
    await waitFor(() => expect(screen.getAllByText("Turned off").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByRole("button", { name: DISCONNECT_FROM_PROJECT })).toBeNull();
  });
});

describe("the switched-on row beside it", () => {
  it.each(PROVIDERS)("%s: its drawer reads the binding in use, and its Disconnect sends that binding", async (name) => {
    provider = name;
    await open(IN_USE);
    await waitFor(() => expect(screen.getAllByText("Last check failed").length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText("Turned off")).toBeNull();
    expect(enabledSwitch()).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: DISCONNECT_FROM_PROJECT }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    // Rocket.Chat's room list and Coolify's application list are POST reads; only the delete is an act.
    const deletes = () => sent.filter((s) => s.method === "DELETE");
    await waitFor(() => expect(deletes().length).toBe(1));
    expect(deletes()).toEqual([{ method: "DELETE", path: `/projects/${PROJECT}/integrations/${IN_USE}` }]);
  });
});

describe("a row naming a binding the list no longer holds", () => {
  it.each(PROVIDERS)("%s: its drawer says so and offers no other binding's controls", async (name) => {
    provider = name;
    await open("0badc0de-0000-4000-8000-000000000000");
    await waitFor(() => expect(screen.getByText(/binding is no longer on this project\./)).toBeInTheDocument());
    expect(screen.queryByRole("switch", { name: /Enabled for this project/ })).toBeNull();
    expect(screen.queryByRole("button", { name: DISCONNECT_FROM_PROJECT })).toBeNull();
    expect(screen.queryByDisplayValue(/new-in-use/)).toBeNull();
  });
});
