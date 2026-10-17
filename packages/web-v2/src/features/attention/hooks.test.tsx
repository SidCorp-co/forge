// @vitest-environment jsdom
//
// ISS-1156 — the attention read says whether it has been read. A count, a badge or an empty list is
// stated only from a read that came in: before it, or after it failed, `total` is undefined and
// `read` says which, so no reader mistakes an empty default for an answer of nothing.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server: {
  attention: (orgId?: string | null) => Promise<unknown>;
  devices: () => Promise<unknown>;
  activeOrgId: string | null;
  scopeRead: boolean;
} = {
  attention: async () => ({}),
  devices: async () => [],
  activeOrgId: null,
  scopeRead: true,
};

vi.mock("./api", () => ({ attentionApi: { list: (orgId?: string | null) => server.attention(orgId) } }));
vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrgId: server.activeOrgId, scopeRead: server.scopeRead }),
}));
vi.mock("@/features/runners/hooks", async () => {
  const { useQuery } = await import("@tanstack/react-query");
  return {
    useDevices: () => useQuery({ queryKey: ["devices", "me", null], queryFn: () => server.devices() }),
  };
});

const { useAttention } = await import("./hooks");

const response = {
  needsReview: [],
  awaitingInput: [{ kind: "awaiting_input", title: "t", link: "/l", since: "2026-10-01T00:00:00Z" }],
  mentions: [],
  failedJobs: [],
  pendingSkillUpdates: [],
  unseenDrafts: [],
  unseenDraftsTotal: 0,
  projectTotals: {},
  total: 1,
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrap({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  server.attention = async () => response;
  server.devices = async () => [];
  server.activeOrgId = null;
  server.scopeRead = true;
});
afterEach(cleanup);

describe("useAttention", () => {
  // ISS-1229 r13, judge-30: the cap was filled across organisations and the screen filtered after it,
  // so the active organisation's items could be cut before the filter saw them. The read asks the
  // route for the active organisation, which cuts before its cap.
  it("asks for the active organisation's items, and every organisation's where none is active", async () => {
    const asked: Array<string | null | undefined> = [];
    server.attention = async (orgId) => {
      asked.push(orgId);
      return response;
    };
    server.activeOrgId = "11111111-1111-4111-8111-111111111111";
    const scoped = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(scoped.result.current.read).toBe("read"));
    server.activeOrgId = null;
    const whole = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(whole.result.current.read).toBe("read"));
    expect(asked).toEqual(["11111111-1111-4111-8111-111111111111", null]);
  });

  it("asks nothing while the active organisation is still being read, then asks for it alone", async () => {
    const asked: Array<string | null | undefined> = [];
    server.attention = async (orgId) => {
      asked.push(orgId);
      return response;
    };
    server.scopeRead = false;
    const hook = renderHook(() => useAttention(), { wrapper: wrapper() });
    await new Promise((r) => setTimeout(r, 50));
    expect(asked).toEqual([]);
    expect(hook.result.current.total).toBeUndefined();
    server.scopeRead = true;
    server.activeOrgId = "11111111-1111-4111-8111-111111111111";
    hook.rerender();
    await waitFor(() => expect(hook.result.current.read).toBe("read"));
    expect(asked).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  it("states no total while the attention answer is on its way, and one once both reads are in", async () => {
    server.attention = () => new Promise(() => {});
    const slow = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(slow.result.current.devicesRead).toBe("read"));
    expect(slow.result.current.read).toBe("pending");
    expect(slow.result.current.total).toBeUndefined();
    expect(slow.result.current.badge).toEqual({ badgeRead: "pending", badgeCounts: "need attention" });

    server.attention = async () => response;
    const done = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(done.result.current.total).toBe(1));
    expect(done.result.current.read).toBe("read");
    expect(done.result.current.badge).toEqual({ badge: 1, badgeCounts: "need attention" });
  });

  it("states no total when the attention read answered 500, though the devices read came in", async () => {
    server.attention = async () => {
      throw new Error("Internal Server Error");
    };
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.read).toBe("failed"));
    expect(result.current.total).toBeUndefined();
    expect(String(result.current.error)).toContain("Internal Server Error");
    expect(result.current.badge).toEqual({ badgeRead: "failed", badgeCounts: "need attention" });
  });

  it("states no total while the devices are unread: an offline runner would be missing from it", async () => {
    server.devices = () => new Promise(() => {});
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.read).toBe("read"));
    expect(result.current.devicesRead).toBe("pending");
    expect(result.current.total).toBeUndefined();
    expect(result.current.badge).toEqual({ badgeRead: "pending", badgeCounts: "need attention" });
  });

  it("states no total when the devices read failed, and names which of the two did", async () => {
    server.devices = async () => {
      throw new Error("devices down");
    };
    const { result } = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.devicesRead).toBe("failed"));
    expect(result.current.read).toBe("read");
    expect(result.current.total).toBeUndefined();
    expect(result.current.badge).toEqual({ badgeRead: "failed", badgeCounts: "need attention" });
  });

  it("states a read zero as a zero, and a refetch that fails over a held count as failed rather than as the count", async () => {
    server.attention = async () => ({ ...response, awaitingInput: [] });
    const zero = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(zero.result.current.read).toBe("read"));
    await waitFor(() => expect(zero.result.current.devicesRead).toBe("read"));
    expect(zero.result.current.badge).toEqual({ badge: 0, badgeCounts: "need attention" });

    server.attention = async () => response;
    const held = renderHook(() => useAttention(), { wrapper: wrapper() });
    await waitFor(() => expect(held.result.current.badge).toEqual({ badge: 1, badgeCounts: "need attention" }));
    server.attention = async () => {
      throw new Error("Internal Server Error");
    };
    await held.result.current.refetch();
    await waitFor(() => expect(held.result.current.read).toBe("failed"));
    expect(held.result.current.badge).toEqual({ badgeRead: "failed", badgeCounts: "need attention" });
    expect(held.result.current.total).toBeUndefined();
    expect("total" in held.result.current.view).toBe(false);
  });
});
