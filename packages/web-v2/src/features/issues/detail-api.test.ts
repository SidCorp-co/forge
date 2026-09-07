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
      json({ items: [node], returned: 1, total: 7, limit: 50, nextCursor: null, hasMore: false }),
    );

    const res = await issueDetailApi.listComments("i1");

    expect(res.items).toEqual([node]);
    // cm:why 7 rather than the 1 node returned — core's `total` counts every comment on the issue including replies, and a page carries only its roots, so it is the one count that means the same thing on page one as on the last page
    expect(res.totalCount).toBe(7);
  });

  it("walks every page, so the screen shows the thread and not its first page", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [node], returned: 1, total: 2, limit: 1, nextCursor: "tok", hasMore: true }),
    );
    const second = { id: "c2", body: "there", replies: [] };
    fetchMock.mockResolvedValueOnce(
      json({ items: [second], returned: 1, total: 2, limit: 1, nextCursor: null, hasMore: false }),
    );

    await expect(issueDetailApi.listComments("i1")).resolves.toEqual({
      items: [node, second],
      totalCount: 2,
    });
  });

  // cm:guard ISS-893's bare-array case is GONE from this route on purpose, and its replacement must be a throw. A bare array carries no cursor, so a walk that tolerated it would stop after page one having pushed nothing and hand the screen an empty thread — the same silent truncation ISS-893 was about, arriving through the fix for it.
  it("refuses a shape it cannot page rather than answering an empty thread", async () => {
    fetchMock.mockResolvedValueOnce(json([node], { "X-Total-Count": "1" }));

    await expect(issueDetailApi.listComments("i1")).rejects.toThrow(/no cursor envelope/);
  });
});
