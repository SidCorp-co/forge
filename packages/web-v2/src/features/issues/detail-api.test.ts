/**
 * ISS-893 — the comment tree answers the `{ items, total, … }` envelope
 * (86c46336 / ISS-889 §2). Read as a bare array it is an OBJECT that passes
 * every truthiness guard and then throws `TypeError: e is not iterable` in the
 * first thing that walks it — which took out EVERY issue-detail page on
 * forge-beta, not just one issue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/auth-api", () => ({ getAccessToken: () => "test-token" }));

const { issueDetailApi } = await import("./detail-api");

const fetchMock = vi.fn();

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

const node = { id: "c1", body: "hi", replies: [] };

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("issueDetailApi.listComments", () => {
  it("unwraps the envelope core answers, and states core's total rather than the page length", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [node], returned: 1, total: 7, limit: 1000, offset: 0, hasMore: false }),
    );

    const res = await issueDetailApi.listComments("i1");

    expect(res.items).toEqual([node]);
    // cm:why 7 rather than the 1 node returned — core's `total` counts every comment on the issue including replies, which is what makes it the only count that stays right when the tree is capped at COMMENT_TREE_HARD_CAP
    expect(res.totalCount).toBe(7);
  });

  it("still reads a bare array + X-Total-Count, for routes not yet on the envelope", async () => {
    fetchMock.mockResolvedValueOnce(json([node], { "X-Total-Count": "1" }));

    await expect(issueDetailApi.listComments("i1")).resolves.toEqual({
      items: [node],
      totalCount: 1,
    });
  });
});
