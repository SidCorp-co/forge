// ISS-1156 — the board asks the search for the count of each open work state beside its page, and
// refuses a response that carries none, by name, rather than draw a cut page and say nothing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiClientList } = vi.hoisted(() => ({ apiClientList: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: vi.fn(), apiClientList }));

import { pipelineApi, requireBoardBuckets } from "./api";

const row = (id: string) => ({ id, displayId: id, status: "in_progress", held: true, lastCheckInAt: null });
const BY = { open: 1, in_flight: 2, awaiting_release: 3, blocked_on_person: 4, draft: 0, finished: 0 };

beforeEach(() => apiClientList.mockReset());

describe("pipelineApi.issuesForProject", () => {
  it("asks for the work state counts with its page", async () => {
    apiClientList.mockResolvedValue({ items: [row("ISS-1")], totalCount: 10, extra: { buckets: { byWorkState: BY } } });
    await pipelineApi.issuesForProject("p1");
    const url = String(apiClientList.mock.calls[0]?.[0]);
    expect(new URL(url, "https://x.test").searchParams.get("withBuckets")).toBe("true");
  });

  it("answers the page together with the counts, so the heads and the counts are one response", async () => {
    apiClientList.mockResolvedValue({ items: [row("ISS-1")], totalCount: 10, extra: { buckets: { byWorkState: BY } } });
    const page = await pipelineApi.issuesForProject("p1");
    expect(page.extra.buckets.byWorkState).toEqual(BY);
  });

  it("refuses a response with no counts, naming the missing state and the search", async () => {
    apiClientList.mockResolvedValue({ items: [row("ISS-1")], totalCount: 1 });
    await expect(pipelineApi.issuesForProject("p1")).rejects.toThrow(
      /issues\/search.*no count for the work state `open`.*cannot say how many issues its page leaves undrawn/u,
    );
  });
});

describe("requireBoardBuckets", () => {
  it("refuses a count missing for one open state, naming it", () => {
    const { blocked_on_person: _gone, ...partial } = BY;
    expect(() => requireBoardBuckets({ extra: { buckets: { byWorkState: partial } } })).toThrow(
      /`blocked_on_person`/u,
    );
  });

  it("does not ask for the two states the board leaves out", () => {
    const { draft: _d, finished: _f, ...open } = BY;
    const page = { extra: { buckets: { byWorkState: open } } };
    expect(requireBoardBuckets(page)).toBe(page);
  });
});
