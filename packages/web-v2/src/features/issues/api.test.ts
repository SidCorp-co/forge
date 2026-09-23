import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseBatchApi } from "./api";

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
