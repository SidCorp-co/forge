// @vitest-environment jsdom
//
// ISS-1228 round 25 (criterion 250, review F1): a check-in now passes by a read Forge refused for
// good, so coming back to the tab is how any such read, on any page, is asked again. A read that
// answered, or failed in a way its poll retries, is not re-read on focus.

import { focusManager, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { createQueryClient } from "./query-provider";

const unsubs: Array<() => void> = [];
const tick = () => new Promise<void>((r) => setTimeout(r, 20));

afterEach(() => {
  while (unsubs.length > 0) unsubs.pop()?.();
  focusManager.setFocused(undefined);
});

async function focusedAfter(first: () => Promise<unknown>) {
  const qc = createQueryClient();
  // As QueryClientProvider does: a client hears focus only once mounted.
  qc.mount();
  unsubs.push(() => qc.unmount());
  const queryFn = vi.fn(first);
  const observer = new QueryObserver(qc, { queryKey: ["agent-session", "s1"], queryFn });
  unsubs.push(observer.subscribe(() => {}));
  await tick();
  queryFn.mockImplementation(async () => ({ ok: true }));
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  await tick();
  return { calls: queryFn.mock.calls.length, observer };
}

describe("coming back to the tab", () => {
  it.each([403, 404])("asks a read refused %i again, with no option of its own, and clears the failure", async (status) => {
    const { calls, observer } = await focusedAfter(async () => {
      throw new ApiError(status, "Not a project member.", "FORBIDDEN");
    });
    expect(calls).toBe(2);
    expect(observer.getCurrentResult().isError).toBe(false);
  });

  it("leaves a read that answered to its poll and its events", async () => {
    const { calls } = await focusedAfter(async () => ({ ok: true }));
    expect(calls).toBe(1);
  });

  it("leaves a 409, which its poll asks again, alone", async () => {
    const { calls } = await focusedAfter(async () => {
      throw new ApiError(409, "Try again in a minute.", "CONFLICT");
    });
    expect(calls).toBe(1);
  });
});
