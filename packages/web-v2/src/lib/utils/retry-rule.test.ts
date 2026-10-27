// ISS-1229 r50 review F1: where one Retry stood for several failed reads, the first read's error alone decided it,
// so a refused read hid Retry for a read the server could not answer, or Retry asked a refused read again.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api/client";
import { isRetryableApiError, retryFailedReads } from "./retry-rule";

const refused = new ApiError(403, "You do not have access to this.");
const busy = new ApiError(503, "The server is busy.");

describe("one Retry for several failed reads", () => {
  it.each([
    ["the refused read first", [refused, busy]],
    ["the busy read first", [busy, refused]],
  ])("is offered with %s, and reads again only the read the rule allows", (_, [first, second]) => {
    const again = [vi.fn(), vi.fn()];
    const one = retryFailedReads([
      { failed: true, error: first, retry: again[0] as () => void },
      { failed: true, error: second, retry: again[1] as () => void },
    ]);
    expect(isRetryableApiError(one.error)).toBe(true);
    one.onRetry();
    expect(again[0]).toHaveBeenCalledTimes(first === busy ? 1 : 0);
    expect(again[1]).toHaveBeenCalledTimes(second === busy ? 1 : 0);
  });

  it("is not offered where every failed read was refused", () => {
    const one = retryFailedReads([
      { failed: true, error: refused, retry: vi.fn() },
      { failed: true, error: new ApiError(404, "Not found."), retry: vi.fn() },
    ]);
    expect(isRetryableApiError(one.error)).toBe(false);
  });

  it("reads nothing again that did not fail", () => {
    const answered = vi.fn();
    const failed = vi.fn();
    retryFailedReads([
      { failed: false, error: null, retry: answered },
      { failed: true, error: busy, retry: failed },
    ]).onRetry();
    expect(answered).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
