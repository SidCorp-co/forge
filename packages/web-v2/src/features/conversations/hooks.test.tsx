// @vitest-environment jsdom
//
// ISS-1229 r29, the master's ruling: a room deleted by another member, opened from a list still showing
// it, answered from the cache and said nothing until the 60-second re-read found it gone.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";

const detail = vi.fn();
vi.mock("./api", () => ({ conversationsApi: { detail: (id: string) => detail(id) } }));
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { useConversation } from "./hooks";

describe("opening a room", () => {
  it("reads it again on opening, though a fresh copy of it is cached", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
    qc.setQueryData(["conversations", "c1"], { id: "c1", messages: [] });
    detail.mockRejectedValueOnce(new ApiError(404, "This room no longer exists.", "CONVERSATION_GONE"));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useConversation("c1"), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(detail).toHaveBeenCalledWith("c1");
    expect((result.current.error as ApiError).code).toBe("CONVERSATION_GONE");
  });
});
