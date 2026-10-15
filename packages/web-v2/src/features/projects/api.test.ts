import { afterEach, describe, expect, it, vi } from "vitest";
import { projectApi } from "./api";

/**
 * ISS-1228 — the rail and the console say how many sessions are live from the health rollup. A row
 * the server sent without that count is refused by name: read as zero, every project would say
 * none is live while sessions work.
 */

const WORK = { open: 1, in_flight: 0, awaiting_release: 0, blocked_on_person: 0, draft: 0, finished: 0 };
const row = (over: Record<string, unknown> = {}) => ({ id: "p1", projectSlug: "sable", work: WORK, liveRuns: 4, liveSessions: 0, ...over });

function answers(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("projectApi.health", () => {
  it("answers rows that carry the live-session count, zero included", async () => {
    answers([row()]);
    await expect(projectApi.health()).resolves.toMatchObject([{ liveSessions: 0, liveRuns: 4 }]);
  });

  it("refuses a row with no live-session count, naming the project and the field", async () => {
    const { liveSessions: _gone, ...older } = row();
    answers([older]);
    await expect(projectApi.health()).rejects.toThrow(/row for `sable` has no `liveSessions` count/);
  });
});
