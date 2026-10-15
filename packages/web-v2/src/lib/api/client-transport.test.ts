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

describe("a failure the server said nothing about is carried in words, never as its reason phrase", async () => {
  const { formatApiError } = await import("./error");

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  async function failureOf(res: Response): Promise<string> {
    fetchMock.mockResolvedValue(res);
    const err = await apiClient("/projects/p").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    return formatApiError(err);
  }

  it.each([
    [400, "Bad Request", "", "The server refused the request without saying why."],
    [429, "Too Many Requests", "<html><body>Too Many Requests</body></html>", "Too many requests in a short time. Wait a moment, then try again."],
    [413, "Payload Too Large", "<html>413</html>", "What was sent is larger than the server accepts."],
    [500, "Internal Server Error", "", "The server ran into a problem and could not finish the request."],
  ])("%i with no message of its own reads as words", async (status, statusText, body, words) => {
    const said = await failureOf(new Response(body, { status, statusText }));
    expect(said).toBe(words);
    expect(said).not.toContain(statusText);
    expect(said).not.toMatch(/\d{3}/);
  });

  it("a JSON body whose message is only the reason phrase reads as words too", async () => {
    const said = await failureOf(
      new Response(JSON.stringify({ message: "Bad Request" }), {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(said).toBe("The server refused the request without saying why.");
  });

  it("a message the server wrote is what a person reads", async () => {
    const said = await failureOf(
      new Response(JSON.stringify({ message: "Base branch is required." }), {
        status: 400,
        statusText: "Bad Request",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(said).toBe("Base branch is required.");
  });

  it("an HTTP/2 answer, which has no reason phrase, reads as words as well", async () => {
    const said = await failureOf(new Response("", { status: 400, statusText: "" }));
    expect(said).toBe("The server refused the request without saying why.");
  });
});
