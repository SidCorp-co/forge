// @vitest-environment jsdom
//
// ISS-1421 r25, judge-101: a double-click on the confirming Disconnect sent DELETE twice, and the
// second answered that the first had already removed it. One intent is one write.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const pending: Array<() => void> = [];
const held = () => new Promise<undefined>((resolve) => pending.push(() => resolve(undefined)));
const removeBinding = vi.fn(held);
const removeConnection = vi.fn(held);

const toast = vi.fn();
const refuseUpdate = vi.fn(async () => {
  throw new Error("The binding was removed.");
});
vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [] }) }));
vi.mock("./api", () => ({
  integrationsApi: { remove: removeBinding, update: refuseUpdate },
  integrationConnectionsApi: { remove: removeConnection },
}));

const { useDeleteProviderIntegration, useRemoveConnection, useUpdateProviderIntegration } =
  await import("./hooks");

afterEach(() => {
  cleanup();
  pending.splice(0);
  removeBinding.mockClear();
  removeConnection.mockClear();
});

function client() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Lets every request asked for so far start, then answers each of them. */
const settle = async () => {
  await act(async () => {
    await tick();
    for (const release of pending.splice(0)) release();
    await tick();
  });
};

describe.each([
  ["a binding's Disconnect", () => useDeleteProviderIntegration("p1"), removeBinding],
  ["a connection's Delete or Clear", () => useRemoveConnection(), removeConnection],
])("%s pressed twice before the first answer", (_name, hook, sent) => {
  it("sends one request", async () => {
    const { result } = renderHook(hook, client());

    act(() => {
      result.current.mutate("b1");
      result.current.mutate("b1");
    });
    await settle();

    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("sends again once the first has answered", async () => {
    const { result } = renderHook(hook, client());

    act(() => result.current.mutate("b1"));
    await settle();
    act(() => result.current.mutate("b1"));
    await settle();

    expect(sent).toHaveBeenCalledTimes(2);
  });

  it("still runs what the caller asked for once it answers", async () => {
    const { result } = renderHook(hook, client());
    const onSuccess = vi.fn();

    act(() => result.current.mutate("b1", { onSuccess }));
    await settle();

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

// ISS-1421 r25, judge-102 (d): a refusal the probe field shows in its question was toasted over it too.
describe("an update whose caller says its own refusal", () => {
  it.each([
    ["says it in a toast where the caller does not", undefined, 1],
    ["says nothing in a toast where the caller does", { failureSaidHere: true }, 0],
  ])("%s", async (_name, options, toasts) => {
    toast.mockClear();
    const { result } = renderHook(() => useUpdateProviderIntegration("p1", options), client());

    await act(async () => {
      await result.current.mutateAsync({ id: "b1", body: {} }).catch(() => undefined);
    });

    expect(toast).toHaveBeenCalledTimes(toasts);
  });
});
