import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issuesApi, releaseBatchApi } from "./api";

/**
 * The parser is only worth having if it sits ON the request path. These drive
 * `releaseBatchApi.roster` with `fetch` stubbed, so a parser wired beside the
 * call rather than into it goes red here (ISS-1142).
 */

const ROSTER = {
  gateStatus: "tested",
  channels: ["coolify"],
  releaseRunnerLabel: "release",
  baseBranch: "main",
  nextCutAt: null,
  issues: [],
};

function answers(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("releaseBatchApi.roster", () => {
  it("answers the roster a well-formed response carries", async () => {
    answers(ROSTER);
    await expect(releaseBatchApi.roster("p1")).resolves.toEqual(ROSTER);
  });

  it("rejects a response the server no longer sends channels in", async () => {
    const { channels, ...withoutChannels } = ROSTER;
    answers(withoutChannels);
    await expect(releaseBatchApi.roster("p1")).rejects.toThrow(
      /release-batches\/roster answered a release roster this app cannot read: channels/,
    );
  });

  it("rejects a response that renamed a key this app reads", async () => {
    const { nextCutAt, ...renamed } = ROSTER;
    answers({ ...renamed, nextCut: null });
    await expect(releaseBatchApi.roster("p1")).rejects.toThrow(/nextCutAt/);
  });
});

describe("issuesApi.search (ISS-1156)", () => {
  const BY_WORK_STATE = {
    open: 1,
    in_flight: 2,
    awaiting_release: 3,
    blocked_on_person: 4,
    draft: 5,
    finished: 6,
  };
  const page = (buckets: unknown) => ({ items: [], total: 0, ...(buckets === undefined ? {} : { buckets }) });

  it("answers a page whose buckets count every work state", async () => {
    answers(page({ byStatus: {}, byWorkState: BY_WORK_STATE }));
    await expect(issuesApi.search("p1", {})).resolves.toMatchObject({
      extra: { buckets: { byWorkState: BY_WORK_STATE } },
    });
  });

  it("rejects buckets in the shape that predates the work states, naming the key", async () => {
    answers(page({ byStatus: {}, waitingOnPersonByStatus: {} }));
    await expect(issuesApi.search("p1", {})).rejects.toThrow(/byWorkState.*work state `open`/);
  });

  it("rejects a page with no buckets at all", async () => {
    answers(page(undefined));
    await expect(issuesApi.search("p1", {})).rejects.toThrow(/byWorkState/);
  });

  it("rejects buckets that leave one state uncounted rather than reading it as zero", async () => {
    const { finished, ...short } = BY_WORK_STATE;
    answers(page({ byStatus: {}, byWorkState: short }));
    await expect(issuesApi.search("p1", {})).rejects.toThrow(/work state `finished`/);
  });
});
