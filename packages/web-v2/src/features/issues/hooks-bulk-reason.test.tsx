// @vitest-environment jsdom
//
// ISS-1251 round 4 — a bulk status update carries its one reason to every issue it moves, so each
// issue's thread is announced with it, and a bulk update that has none sends none.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
const transition = vi.fn();
const patch = vi.fn();

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("./api", () => ({
  issuesApi: {
    transition: (...args: unknown[]) => transition(...args),
    patch: (...args: unknown[]) => patch(...args),
  },
  modulesApi: {},
  releaseBatchApi: {},
}));
vi.mock("./registry-api", () => ({ registryApi: {} }));

const { useBulkUpdateIssues } = await import("./hooks");

afterEach(() => {
  cleanup();
  toast.mockClear();
  transition.mockReset();
  patch.mockReset();
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useBulkUpdateIssues(), { wrapper });
}

describe("useBulkUpdateIssues with a reason", () => {
  it("sends the same reason with the move of every selected issue", async () => {
    transition.mockResolvedValue({});
    const { result } = setup();
    await act(async () =>
      result.current.mutate({
        ids: ["a", "b", "c"],
        update: { kind: "status", toStatus: "on_hold", reason: "the window is closed" },
      }),
    );
    await waitFor(() => expect(transition).toHaveBeenCalledTimes(3));
    for (const id of ["a", "b", "c"]) {
      expect(transition).toHaveBeenCalledWith(id, "on_hold", { reason: "the window is closed" });
    }
  });

  it("tallies the issues the tracker refused, so a bulk hold says how many moved", async () => {
    transition.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("refused");
    });
    const { result } = setup();
    await act(async () =>
      result.current.mutate({
        ids: ["a", "b"],
        update: { kind: "status", toStatus: "on_hold", reason: "the window is closed" },
      }),
    );
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls.at(-1)?.[0]).toMatchObject({ title: "1 updated · 1 failed", tone: "error" });
  });

  it("sends no reason for a bulk update that has none", async () => {
    transition.mockResolvedValue({});
    const { result } = setup();
    await act(async () =>
      result.current.mutate({ ids: ["a"], update: { kind: "status", toStatus: "dropped" } }),
    );
    await waitFor(() => expect(transition).toHaveBeenCalledTimes(1));
    expect(transition).toHaveBeenCalledWith("a", "dropped", { reason: undefined });
  });
});
