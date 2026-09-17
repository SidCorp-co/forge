/**
 * The rule this file defends: a request core answered is core's to report, and
 * a request that never arrived is ours.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
vi.mock("@sentry/react", () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

const { reportTransportFailure } = await import("./transport-failure");

const REQ = { url: "https://forge-beta-api.sidcorp.co/api/health", method: "POST" };

function setOnline(value: boolean): void {
  Object.defineProperty(globalThis.navigator, "onLine", { value, configurable: true });
}

describe("reportTransportFailure", () => {
  beforeEach(() => {
    captureException.mockClear();
    setOnline(true);
  });

  it("reports an opaque fetch rejection, which is the only kind core cannot see", () => {
    const err = new TypeError("Failed to fetch");

    expect(reportTransportFailure(err, REQ)).toBe("reported");
    expect(captureException).toHaveBeenCalledTimes(1);

    const [sent, options] = captureException.mock.calls[0] as [unknown, Record<string, never>];
    expect(sent).toBe(err);
    expect(options.tags).toMatchObject({ area: "api-transport", outcome: "unreachable" });
  });

  it("carries the url and method, because the event has no request context of its own", () => {
    reportTransportFailure(new TypeError("Failed to fetch"), REQ);

    const [, options] = captureException.mock.calls[0] as [unknown, Record<string, never>];
    expect(options.contexts).toMatchObject({
      forge_request: { url: REQ.url, method: "POST", online: true },
    });
  });

  it("does not report a request the caller aborted", () => {
    const err = new DOMException("The user aborted a request.", "AbortError");

    expect(reportTransportFailure(err, REQ)).toBe("aborted");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("does not report a failure while the browser says it is offline", () => {
    setOnline(false);

    expect(reportTransportFailure(new TypeError("Failed to fetch"), REQ)).toBe("offline");
    expect(captureException).not.toHaveBeenCalled();
  });

  // cm:why the tag must not name a cause: `Failed to fetch` is what the browser
  // returns for CORS, DNS and TLS alike, so a `cors` tag would be a guess.
  it("never claims to know which transport cause it was", () => {
    reportTransportFailure(new TypeError("Failed to fetch"), REQ);

    const [, options] = captureException.mock.calls[0] as [unknown, { tags: Record<string, string> }];
    expect(Object.values(options.tags)).not.toContain("cors");
    expect(Object.values(options.tags)).not.toContain("dns");
  });
});
