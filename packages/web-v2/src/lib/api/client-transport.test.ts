/**
 * The duplicate-reporting rule, asserted where it is actually decided.
 *
 * `transport-failure.test.ts` proves the reporter's own rules. This proves the
 * thing that makes them structural: the reporter wraps the `fetch` CALL, so a
 * response core answered — any status — cannot reach it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureException = vi.fn();
vi.mock("@sentry/react", () => ({ captureException: (...a: unknown[]) => captureException(...a) }));
vi.mock("./auth-api", () => ({ getAccessToken: () => "test-token" }));

const { apiClient, ApiError } = await import("./client");

const fetchMock = vi.fn();

describe("the transport boundary sits around fetch, not around the response", () => {
  beforeEach(() => {
    captureException.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("reports nothing for a 500 — core already filed that one with a stack and a request id", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "boom", code: "INTERNAL" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(apiClient("/whatever")).rejects.toBeInstanceOf(ApiError);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports nothing for a 404 either — a status is an answer, not a transport failure", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 404 }));

    await expect(apiClient("/whatever")).rejects.toBeInstanceOf(ApiError);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports the rejection when fetch itself never got an answer", async () => {
    const err = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(err);

    await expect(apiClient("/whatever")).rejects.toBe(err);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("rethrows untouched, so reporting never changes what a caller sees", async () => {
    const err = new TypeError("Failed to fetch");
    fetchMock.mockRejectedValue(err);

    await expect(apiClient("/whatever")).rejects.toBe(err);
  });
});
