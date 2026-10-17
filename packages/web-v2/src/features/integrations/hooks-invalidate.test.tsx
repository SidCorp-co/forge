// @vitest-environment jsdom
//
// ISS-1421 r5 repair 1 — Connect from the project Integrations tab makes a connection, yet the
// "Share an existing connection" section went on saying there was none until a reload: the save
// refreshed the project's integration reads and never the connections that section reads.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/providers/toast-provider", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/features/projects/hooks", () => ({ useProjects: () => ({ data: [] }) }));
vi.mock("./api", () => ({
  integrationsApi: {
    create: vi.fn(async () => ({ id: "b1" })),
    update: vi.fn(async () => ({ id: "b1" })),
    remove: vi.fn(async () => undefined),
  },
  integrationConnectionsApi: {},
}));

const { useCreateProviderIntegration } = await import("./hooks");

afterEach(cleanup);

function harness() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["integration-connections"], { items: [] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

describe("a provider saved from the project Integrations tab", () => {
  it("marks the connections the Share section reads stale, so it lists the new one without a reload", async () => {
    const { qc, wrapper } = harness();
    const { result } = renderHook(() => useCreateProviderIntegration("p1"), { wrapper });

    await act(() => result.current.mutateAsync({ provider: "coolify" } as never));

    expect(qc.getQueryState(["integration-connections"])?.isInvalidated).toBe(true);
  });
});
