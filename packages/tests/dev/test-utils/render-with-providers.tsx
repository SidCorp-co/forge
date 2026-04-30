import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { renderHook, type RenderHookOptions, type RenderHookResult } from "@testing-library/react";
import { vi } from "vitest";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

interface RenderHookWithProvidersOptions<TProps> extends Omit<RenderHookOptions<TProps>, "wrapper"> {
  initialEntries?: string[];
  queryClient?: QueryClient;
}

export function renderHookWithProviders<TResult, TProps>(
  hook: (props: TProps) => TResult,
  options: RenderHookWithProvidersOptions<TProps> = {},
): RenderHookResult<TResult, TProps> & { queryClient: QueryClient } {
  const { initialEntries = ["/"], queryClient = createTestQueryClient(), ...rest } = options;

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
    </QueryClientProvider>
  );

  const result = renderHook(hook, { wrapper, ...rest });
  return Object.assign(result, { queryClient });
}

export function stubTauriEnv(): void {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

export function clearTauriEnv(): void {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

export function mockTauriCore(invoke: ReturnType<typeof vi.fn>): void {
  vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
}
