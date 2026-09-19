/**
 * ISS-1017 — the list's search call carries `withDependencies=1`.
 *
 * The flag is the list's ONLY source of dependency edges since `DepBadges`
 * stopped fetching per row, so dropping it does not blank a column: it
 * silently renders every row as having no relations. Nothing else in the
 * module would go red, which is what this file is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/auth-api", () => ({ getAccessToken: () => "test-token" }));

const { issuesApi } = await import("./api");

const fetchMock = vi.fn();

const PROJECT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { "content-type": "application/json", "x-total-count": "0" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const paramsOfLastCall = () => {
  const url = String(fetchMock.mock.calls.at(-1)?.[0]);
  return new URL(url, "https://example.test").searchParams;
};

describe("issuesApi.search", () => {
  it("opts into the page-wide dependency hydration", async () => {
    await issuesApi.search(PROJECT, {});
    expect(paramsOfLastCall().get("withDependencies")).toBe("1");
  });

  it("keeps the other grouped-query opt-ins the row cells read", async () => {
    await issuesApi.search(PROJECT, {});
    const params = paramsOfLastCall();
    for (const flag of [
      "withAgentSessions",
      "withCost",
      "withFailureInfo",
      "withPipelineHealth",
      "withModules",
      "withBuckets",
    ]) {
      expect(params.get(flag)).toBe("1");
    }
  });
});
