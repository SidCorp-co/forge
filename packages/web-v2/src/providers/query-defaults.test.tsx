// @vitest-environment jsdom

import { type QueryClient, QueryObserver, focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { QUERY_MAX_RETRIES, createQueryClient, shouldRetryQuery } from "./query-provider";

const tick = (ms = 80) => new Promise<void>((r) => setTimeout(r, ms));
const unsubs: Array<() => void> = [];

const mounted: QueryClient[] = [];

/** The very client `QueryProvider` runs on, not a copy of its options. */
function client(): QueryClient {
  const qc = createQueryClient();
  qc.mount();
  mounted.push(qc);
  return qc;
}

function mount(qc: QueryClient, queryKey: unknown[], queryFn: () => Promise<unknown>) {
  const observer = new QueryObserver(qc, { queryKey, queryFn, retryDelay: 1 });
  unsubs.push(observer.subscribe(() => {}));
}

afterEach(() => {
  while (unsubs.length > 0) unsubs.pop()?.();
  while (mounted.length > 0) mounted.pop()?.unmount();
  focusManager.setFocused(undefined);
});

async function blurThenFocus() {
  focusManager.setFocused(false);
  await tick(10);
  focusManager.setFocused(true);
  await tick();
}

describe("the project's query defaults", () => {
  it("does not retry a request the server refused with a 4xx", async () => {
    const qc = client();
    let calls = 0;
    mount(qc, ["issues", "list"], async () => {
      calls += 1;
      throw new ApiError(403, "forbidden", "FORBIDDEN");
    });
    await tick();
    expect(calls).toBe(1);
  });

  it("still retries a 5xx twice", async () => {
    const qc = client();
    let calls = 0;
    mount(qc, ["issues", "list"], async () => {
      calls += 1;
      throw new ApiError(503, "unavailable", "UNAVAILABLE");
    });
    await tick(200);
    expect(calls).toBe(QUERY_MAX_RETRIES + 1);
  });

  it("still retries an error that carries no status at all", () => {
    expect(shouldRetryQuery(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetryQuery(QUERY_MAX_RETRIES, new TypeError("Failed to fetch"))).toBe(false);
  });

  it("refuses every 4xx status, not only the one the case above uses", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(shouldRetryQuery(0, new ApiError(status, "no"))).toBe(false);
    }
  });

  it("does not refetch a stale query on window focus", async () => {
    const qc = client();
    let calls = 0;
    const observer = new QueryObserver(qc, {
      queryKey: ["issues", "list"],
      queryFn: async () => {
        calls += 1;
        return `v${calls}`;
      },
      staleTime: 0,
    });
    unsubs.push(observer.subscribe(() => {}));
    await tick();
    expect(calls).toBe(1);

    await blurThenFocus();

    expect(calls).toBe(1);
  });

  it("refetches the activity feed on window focus, which opts back in", async () => {
    const qc = client();
    let calls = 0;
    const observer = new QueryObserver(qc, {
      queryKey: ["chat-logs", "list", {}],
      queryFn: async () => {
        calls += 1;
        return `v${calls}`;
      },
      refetchOnWindowFocus: true,
      staleTime: 0,
    });
    unsubs.push(observer.subscribe(() => {}));
    await tick();
    expect(calls).toBe(1);

    await blurThenFocus();

    expect(calls).toBe(2);
  });
});
