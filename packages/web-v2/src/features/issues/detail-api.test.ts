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

  it("refuses a shape it cannot page rather than answering an empty thread", async () => {
    fetchMock.mockResolvedValueOnce(json([node], { "X-Total-Count": "1" }));

    await expect(issueDetailApi.listComments("i1")).rejects.toThrow(/no cursor envelope/);
  });
});

/**
 * ISS-1160 — `id` off the issue-detail URL is the display key (`ISS-1185`) as
 * often as the row uuid, and a key resolves only inside a project the caller
 * names. Every read below must carry `?projectId=` when the screen has one,
 * and stay unchanged when it does not (a uuid needs no scope).
 */
describe("issueDetailApi carries ?projectId= for a display-key id (ISS-1160)", () => {
  function lastUrl(): string {
    const call = fetchMock.mock.calls.at(-1);
    return String(call?.[0]);
  }

  it("get() appends projectId when given, and omits it when not", async () => {
    fetchMock.mockImplementation(async () => json({ id: "i1" }));
    await issueDetailApi.get("ISS-1185", "p1");
    expect(lastUrl()).toBe("/api/issues/ISS-1185?projectId=p1");

    await issueDetailApi.get("i1");
    expect(lastUrl()).toBe("/api/issues/i1");
  });

  it("listActivity() appends projectId after the existing ?limit=", async () => {
    fetchMock.mockImplementation(async () => json({ items: [], nextBefore: null }));
    await issueDetailApi.listActivity("ISS-1185", 50, "p1");
    expect(lastUrl()).toBe("/api/issues/ISS-1185/activity?limit=50&projectId=p1");
  });

  it("listTasks() and listAttachments() append projectId", async () => {
    fetchMock.mockImplementation(async () => json([]));
    await issueDetailApi.listTasks("ISS-1185", "p1");
    expect(lastUrl()).toBe("/api/issues/ISS-1185/tasks?projectId=p1");

    await issueDetailApi.listAttachments("ISS-1185", "p1");
    expect(lastUrl()).toBe("/api/issues/ISS-1185/attachments?projectId=p1");
  });

  it("listComments() appends projectId on the first page", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [], returned: 0, total: 0, limit: 50, nextCursor: null, hasMore: false }),
    );
    await issueDetailApi.listComments("ISS-1185", "p1");
    expect(lastUrl()).toBe("/api/issues/ISS-1185/comments?projectId=p1");
  });
});
