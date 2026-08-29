// @vitest-environment jsdom

/**
 * `useAttention` merges core's buckets with the client-derived offline runners.
 * The screen test mocks this module wholesale, so nothing there can fail on
 * what this hook computes — including the one number it must NOT recompute:
 * `unseenDraftsTotal` is core's unclipped match count, and deriving it from the
 * capped list makes a 428-deep backlog render as 20.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AttentionResponse } from "./types";

const list = vi.fn();
vi.mock("./api", () => ({ attentionApi: { list: () => list() } }));
vi.mock("@/features/runners/hooks", () => ({
  useDevices: () => ({ data: [], refetch: vi.fn() }),
}));

const { useAttention } = await import("./hooks");

function response(over: Partial<AttentionResponse> = {}): AttentionResponse {
  return {
    needsReview: [],
    awaitingInput: [],
    mentions: [],
    failedJobs: [],
    pendingSkillUpdates: [],
    unseenDrafts: [],
    unseenDraftsTotal: 0,
    total: 0,
    ...over,
  };
}

function drafts(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    kind: "unseen_draft" as const,
    title: `proposal ${i}`,
    link: `/projects/forge-dev/issues/doc-${i}`,
    since: "2026-08-30T00:00:00.000Z",
    issueRef: `ISS-${900 - i}`,
    status: "draft",
    projectSlug: "forge-dev",
  }));
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe("useAttention", () => {
  it("passes core's unclipped total through instead of measuring the capped list", async () => {
    list.mockResolvedValue(response({ unseenDrafts: drafts(20), unseenDraftsTotal: 428 }));
    const { result } = renderHook(() => useAttention(), { wrapper });
    await waitFor(() => expect(result.current.view.unseenDrafts).toHaveLength(20));
    expect(result.current.view.unseenDraftsTotal).toBe(428);
  });

  // cm:guard `total` is the rail badge. It counts rows SENT, so this bucket can add at most the cap to it — wiring `unseenDraftsTotal` in here would badge 428 on every page of the app.
  it("counts only the rows sent in `total`", async () => {
    list.mockResolvedValue(response({ unseenDrafts: drafts(20), unseenDraftsTotal: 428 }));
    const { result } = renderHook(() => useAttention(), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(20));
  });

  it("reports zero, not NaN, when the endpoint has not answered yet", () => {
    list.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAttention(), { wrapper });
    expect(result.current.view.unseenDraftsTotal).toBe(0);
    expect(result.current.total).toBe(0);
    expect(result.current.isLoading).toBe(true);
  });
});
