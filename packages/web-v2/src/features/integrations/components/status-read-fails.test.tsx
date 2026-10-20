// @vitest-environment jsdom
//
// ISS-1421 r13 — judge-58 pressed Enable credential and Enabled in a drawer, the status read that
// followed failed, and the whole tab became "Couldn't load" with the drawer gone, though both writes
// had landed. A failed refresh keeps the drawer open and says the failure beside what it shows.

import * as matchers from "@testing-library/jest-dom/matchers";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectIntegrationsPanel } from "./project-integrations-panel";

expect.extend(matchers);

const PROJECT = "da368b0a-8e21-4763-9d90-8f7b9d0c7115";
const NOW = "2026-10-14T00:00:00.000Z";
let statusFails = false;

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

const SENTRY_CARD = {
  key: "sentry",
  label: "Sentry",
  status: "connected",
  detail: "Checked.",
  lastSyncAt: NOW,
  configured: true,
  meta: { lastHealthStatus: "ok" },
};

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>("@/lib/api/client");
  return {
    ...actual,
    apiClient: async (path: string) => {
      const bare = path.split("?")[0] ?? path;
      if (bare === `/projects/${PROJECT}/integrations/status`) {
        if (statusFails) throw new actual.ApiError(503, "Service unavailable.");
        return { cards: [SENTRY_CARD] };
      }
      if (bare === "/projects") return [PROJECT_ROW];
      if (bare === `/projects/${PROJECT}`) return { ...PROJECT_ROW, agentConfig: {} };
      return { items: [], bindings: [], servers: [], applications: [], rooms: [], targets: [], repositories: [], truncated: false };
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
  statusFails = false;
  queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
});
afterEach(cleanup);

describe("a status read that fails while a drawer is open", () => {
  it("keeps the drawer open and says the failure inline, not Couldn't load", async () => {
    render(
      <QueryClientProvider client={queries}>
        <ProjectIntegrationsPanel projectId={PROJECT} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Manage Sentry" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();

    statusFails = true;
    await act(async () => {
      await queries.refetchQueries({ queryKey: ["integrations", "status", PROJECT] });
    });
    await waitFor(() =>
      expect(screen.getAllByText(/The status could not be refreshed/).length).toBeGreaterThanOrEqual(1),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load")).toBeNull();
    expect(screen.getByRole("button", { name: "Manage Sentry" })).toBeInTheDocument();
  });

  // The coordinator's 390 shot: a sticky notice pinned itself over the Project slug input once the
  // drawer scrolled. The notice sits in the drawer's flow, before the first field, in no layer of its own.
  it("puts the notice in the drawer's flow before the first field, never in a layer over it", async () => {
    render(
      <QueryClientProvider client={queries}>
        <ProjectIntegrationsPanel projectId={PROJECT} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Manage Sentry" }));
    const dialog = await screen.findByRole("dialog");
    statusFails = true;
    await act(async () => {
      await queries.refetchQueries({ queryKey: ["integrations", "status", PROJECT] });
    });
    const notice = await within(dialog).findByText(/The status could not be refreshed/);
    const firstField = await within(dialog).findByLabelText(/Project slug/i);
    expect(notice.compareDocumentPosition(firstField) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (let el: HTMLElement | null = notice; el && el !== dialog; el = el.parentElement) {
      expect(el.className, "an ancestor of the notice lifts it out of the flow").not.toMatch(
        /(^|\s)(sticky|fixed|absolute)(\s|$)/,
      );
      expect(el.style.position).not.toMatch(/sticky|fixed|absolute/);
    }
  });

  it("still says Couldn't load where no status was ever read", async () => {
    statusFails = true;
    render(
      <QueryClientProvider client={queries}>
        <ProjectIntegrationsPanel projectId={PROJECT} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Couldn't load")).toBeInTheDocument();
  });
});
