// @vitest-environment jsdom
//
// ISS-1421 r13, criterion 144 — judge-58 read "Not checked yet" on the Postman and Epodsystem section
// badges over a check the provider refused, while the row and drawer header said "Needs re-auth", and
// a green "1 connected" over the same refused key. One binding, one reading, in every provider drawer.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { LeaveGuardProvider } from "@/design";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIRECTORY_STATUS_META, deriveDirectoryStatus } from "../derive";
import { ConnectionDetailDrawer } from "./connection-detail-drawer";
import { ALL_ACTS, ALL_MAY } from "../test-acts";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const CONNECTION = "b1d6b9c2-5f3a-4a1e-9f0e-6c2a7d8e4f10";
const BINDING = "c2e7a0d3-6a4b-4b2f-8a1f-7d3b8e9f5a21";
const NOW = "2026-10-14T00:00:00.000Z";

let provider = "postman";
let health: string | null = "needs_reauth";
let breaker: string | null = null;

function row() {
  const deploy = provider === "coolify";
  return {
    id: BINDING,
    connectionId: CONNECTION,
    projectId: PROJECT,
    provider,
    role: deploy ? "deploy" : "service",
    stages: deploy ? ["live"] : [],
    config: { host: "example.test", storeName: "Example store" },
    bindingConfig: {},
    label: "",
    active: true,
    bindingActive: true,
    connectionActive: true,
    lastHealthStatus: health,
    lastHealthAt: health ? NOW : null,
    breakerOpenedAt: breaker,
    hasSecrets: true,
    integrationSecretSet: true,
    agentAccess: "all",
    agentPathKind: "direct-mcp",
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
      if (bare === `/projects/${PROJECT}/integrations`) return { items: [row()], bindings: [row()], may: ALL_MAY };
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
  breaker = null;
  queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
});
afterEach(cleanup);

/** The card the Integrations tab's row reads, bucketed as core's status read buckets it. */
function card() {
  const status =
    health === null ? "unverified" : health === "ok" ? "connected" : health === "error" ? "error" : "attention";
  const deploy = provider === "coolify";
  const meta = {
    bindingId: BINDING,
    lastHealthStatus: health,
    ...(deploy ? { capabilities: { canDeploy: true } } : {}),
  };
  return { key: deploy ? "coolify:live" : provider, status, configured: true, meta };
}

/** The drawer a row opens, or with `adding` the one the tab's Add storefront opens, on no row. */
async function drawer(adding = false): Promise<void> {
  const opened = adding ? { ...card(), meta: {} } : card();
  render(
    <QueryClientProvider client={queries}>
      <LeaveGuardProvider>
        <ConnectionDetailDrawer projectId={PROJECT} card={opened as never} adding={adding} onClose={() => {}} />
      </LeaveGuardProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => {
    expect(queries.isFetching()).toBe(0);
    expect(document.querySelector(".skeleton")).toBeNull();
  });
}

const PROVIDERS = ["sentry", "postman", "epodsystem", "google", "rocketchat", "coolify"];
const STATE_LABELS = ["Not checked yet", "Needs re-auth", "Permission needed", "Last check failed", "Active", "Invalid key"];

describe("a provider drawer's badge reads its binding as the row does", () => {
  for (const [check, words] of [
    ["needs_reauth", "Needs re-auth"],
    ["needs_scope", "Permission needed"],
    ["error", "Last check failed"],
    [null, "Not checked yet"],
    ["ok", "Connected"],
  ] as const) {
    it.each(PROVIDERS)(`%s: a last check of ${String(check)} reads "${words}" on the header and the badge`, async (name) => {
      provider = name;
      health = check;
      expect(DIRECTORY_STATUS_META[deriveDirectoryStatus(card() as never)].label).toBe(words);
      await drawer();
      // The header's pill and the section's badge: the same words, twice.
      await waitFor(() => expect(screen.getAllByText(words).length).toBeGreaterThanOrEqual(2));
      for (const other of STATE_LABELS) {
        if (other !== words) expect(screen.queryByText(other)).toBeNull();
      }
    });
  }
});

// The count heads the drawer Add storefront opens; a row's drawer is about its own store (ISS-1421 r35).
describe("Epodsystem's connected count", () => {
  it("does not count a store whose key the provider refused", async () => {
    provider = "epodsystem";
    health = "needs_reauth";
    await drawer(true);
    await screen.findByText("Epodsystem storefronts");
    expect(screen.queryByText(/\d+ connected$/)).toBeNull();
  });

  it("counts a store whose last check passed", async () => {
    provider = "epodsystem";
    health = "ok";
    await drawer(true);
    expect(await screen.findByText("1 connected")).toBeInTheDocument();
  });
});

// Review F1 on 592ce7d: an open breaker over a passing check read "No default sheet is set to read".
describe("Google's line under the badge", () => {
  it("names what Google's check found, never a cause the check did not report", async () => {
    provider = "google";
    health = "ok";
    breaker = "2026-10-14T00:00:00.000Z";
    await drawer();
    expect(await screen.findAllByText("Degraded")).not.toHaveLength(0);
    expect(screen.queryByText("No default sheet is set to read.")).toBeNull();
  });

  it("says the sheet is missing where the check found it so", async () => {
    provider = "google";
    health = "degraded";
    await drawer();
    expect(await screen.findByText("No default sheet is set to read.")).toBeInTheDocument();
  });
});
