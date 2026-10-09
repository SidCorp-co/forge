// @vitest-environment jsdom
//
// ISS-1156 — the Issues row's open-work figure is stated only from a projects list and a health read
// that both came in. Before them, or after either failed, `openWork` says which: a held count after a
// failed refetch is no statement, and a failed read is never the face of a project with no open work.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server: { list: () => Promise<unknown>; health: () => Promise<unknown> } = {
  list: async () => [],
  health: async () => [],
};

vi.mock("@/features/projects/api", () => ({
  projectApi: { list: () => server.list(), health: () => server.health() },
}));

const { useRailProjectData } = await import("./use-rail-project-data");
const { useProjectHealth } = await import("@/features/projects/hooks");
const { useQueryClient } = await import("@tanstack/react-query");

const sable = { id: "p1", slug: "sable", name: "Sable", orgId: "o1", orgName: "Org", orgIsPersonal: false, role: "admin", createdAt: "2026-10-01T00:00:00Z" };
const healthRow = (totalActive: number) => ({
  id: "p1", projectSlug: "sable", totalActive, blockers: [], pendingEscalations: 0, runnerCount: 1, liveRuns: 0,
});
const OPEN_WORK = "in open work";

let client: QueryClient;
function wrapper() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrap({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
const rail = () => renderHook(() => useRailProjectData({ railSlug: "sable", railProject: null, activeOrgId: null }), { wrapper: wrapper() });

beforeEach(() => {
  server.list = async () => [sable];
  server.health = async () => [healthRow(29)];
});
afterEach(cleanup);

describe("useRailProjectData openWork", () => {
  it("says pending while the health read is on its way, and states the count once it is in", async () => {
    server.health = () => new Promise(() => {});
    const slow = rail();
    await waitFor(() => expect(slow.result.current.railConsole).not.toBeNull());
    expect(slow.result.current.openWork).toEqual({ badgeRead: "pending", badgeCounts: OPEN_WORK });
    cleanup();

    server.health = async () => [healthRow(29)];
    const done = rail();
    await waitFor(() => expect(done.result.current.openWork).toEqual({ badge: 29, badgeCounts: OPEN_WORK }));
  });

  it("says failed, not nothing, when the health read answered 500", async () => {
    server.health = async () => {
      throw new Error("Internal Server Error");
    };
    const { result } = rail();
    await waitFor(() => expect(result.current.openWork).toEqual({ badgeRead: "failed", badgeCounts: OPEN_WORK }));
  });

  it("says failed when the projects list answered 500", async () => {
    server.list = async () => {
      throw new Error("Internal Server Error");
    };
    const { result } = rail();
    await waitFor(() => expect(result.current.openWork).toEqual({ badgeRead: "failed", badgeCounts: OPEN_WORK }));
  });

  it("states a read zero as a zero, and a refetch that fails over a held count as failed rather than as the count", async () => {
    server.health = async () => [healthRow(0)];
    const zero = rail();
    await waitFor(() => expect(zero.result.current.openWork).toEqual({ badge: 0, badgeCounts: OPEN_WORK }));
    cleanup();

    server.health = async () => [healthRow(29)];
    const held = renderHook(
      () => ({ rail: useRailProjectData({ railSlug: "sable", railProject: null, activeOrgId: null }), health: useProjectHealth(), qc: useQueryClient() }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(held.result.current.rail.openWork).toEqual({ badge: 29, badgeCounts: OPEN_WORK }));
    server.health = async () => {
      throw new Error("Internal Server Error");
    };
    await held.result.current.health.refetch();
    await waitFor(() => expect(held.result.current.rail.openWork).toEqual({ badgeRead: "failed", badgeCounts: OPEN_WORK }));
  });
});
