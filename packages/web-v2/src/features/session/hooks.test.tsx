// @vitest-environment jsdom
//
// ISS-1228 round 14 — judge-36 stopped a session from its own page and no toast came, where the
// sessions list and the issue page each said "Session stopped".

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { toast, cancel } = vi.hoisted(() => ({
  toast: vi.fn(),
  cancel: vi.fn(async () => ({ id: "s1", status: "failed" })),
}));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("./api", () => ({ sessionApi: { cancel } }));

import { useCancelSession } from "./hooks";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  toast.mockReset();
});

describe("Stop session on the session page", () => {
  it("says Session stopped, as every other surface that stops one does", async () => {
    const { result } = renderHook(() => useCancelSession("s1"), { wrapper });
    await act(async () => {
      await result.current.mutateAsync();
    });
    expect(cancel).toHaveBeenCalledWith("s1");
    expect(toast).toHaveBeenCalledWith({ title: "Session stopped", tone: "success" });
  });
});
