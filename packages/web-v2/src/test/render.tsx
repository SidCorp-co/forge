import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { vi } from "vitest";

/** A fresh query client per render, retrying nothing, so a refused call surfaces at once; pass the app's own client to test what its defaults do. */
export function renderWithQuery(
  ui: ReactElement,
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
) {
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

/** A reply that never arrives: the request stays in flight for the rest of the test, as a slow read does. */
export const HANG = { hang: true } as const;

export interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Stands in for core over `fetch`: each request is recorded and answered by `reply`, which sees the
 * path after `/api`. A reply of `undefined` is a test that did not expect the call, and fails it.
 */
export function fakeCore(reply: (call: Call) => { status?: number; body: unknown } | typeof HANG | undefined) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://forge.test");
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname.replace(/^\/api/, "")}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = reply(call);
    if (!r) throw new Error(`fakeCore: no reply for ${call.method} ${call.path}`);
    if ("hang" in r) return new Promise<Response>(() => {});
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}
