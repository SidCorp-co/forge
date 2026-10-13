// @vitest-environment jsdom
//
// ISS-1310 — the transition hook's two promises a person meets on the issue page: a second press of
// the same move says nothing, and a move the dialogs promise a reason for reads the thread again.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
const transition = vi.fn();

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("./api", () => ({
  issuesApi: { transition: (...args: unknown[]) => transition(...args) },
  modulesApi: {},
  releaseBatchApi: {},
}));
vi.mock("./registry-api", () => ({ registryApi: {} }));

const { useTransitionIssue } = await import("./hooks");

afterEach(() => {
  cleanup();
  toast.mockClear();
  transition.mockReset();
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { ...renderHook(() => useTransitionIssue(), { wrapper }), invalidate };
}

describe("a repeated press of one move", () => {
  it("sends the move once, and the second press says nothing", async () => {
    let release: () => void = () => {};
    transition.mockReturnValue(new Promise<void>((resolve) => (release = resolve)));
    const { result } = setup();
    const onSuccess = vi.fn();
    await act(async () => {
      result.current.mutate({ id: "i1", toStatus: "developed" }, { onSuccess });
      result.current.mutate({ id: "i1", toStatus: "developed" }, { onSuccess });
    });
    expect(transition).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    expect(toast).not.toHaveBeenCalled();
  });

  it("lets the same move go again once the first has settled", async () => {
    transition.mockResolvedValue({});
    const { result } = setup();
    await act(async () => result.current.mutate({ id: "i1", toStatus: "developed" }));
    await waitFor(() => expect(transition).toHaveBeenCalledTimes(1));
    await act(async () => result.current.mutate({ id: "i1", toStatus: "developed" }));
    await waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
  });

  it("lets the same move go again after the first was refused", async () => {
    transition.mockRejectedValueOnce(new Error("refused")).mockResolvedValue({});
    const { result } = setup();
    await act(async () => result.current.mutate({ id: "i1", toStatus: "developed" }));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    await act(async () => result.current.mutate({ id: "i1", toStatus: "developed" }));
    await waitFor(() => expect(transition).toHaveBeenCalledTimes(2));
  });

  it("does not hold a different issue, or a different target, behind it", async () => {
    transition.mockReturnValue(new Promise(() => {}));
    const { result } = setup();
    await act(async () => {
      result.current.mutate({ id: "i1", toStatus: "developed" });
      result.current.mutate({ id: "i2", toStatus: "developed" });
      result.current.mutate({ id: "i1", toStatus: "in_progress" });
    });
    expect(transition).toHaveBeenCalledTimes(3);
  });
});

describe("a move that posts its reason on the thread", () => {
  it("reads the thread again, so the reason is there without a reload", async () => {
    transition.mockResolvedValue({});
    const { result, invalidate } = setup();
    await act(async () =>
      result.current.mutate({ id: "i1", toStatus: "in_progress", reason: "why" }),
    );
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["comments", "i1"] }),
    );
  });
});
