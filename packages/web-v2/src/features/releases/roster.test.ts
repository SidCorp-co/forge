import { describe, expect, it } from "vitest";
import { RosterShapeError, parseReleaseRoster } from "./roster";

const ENDPOINT = "/projects/p1/release-batches/roster";

const ENTRY = {
  id: "iss-1",
  displayId: "ISS-1",
  title: "Signup accepts a plan that is not sold",
  mergedAt: "2026-08-26T09:00:00.000Z",
  waitingDays: 2,
  claimedByRunId: null,
};

function body(over: Record<string, unknown> = {}) {
  return {
    gateStatus: "tested",
    channels: ["coolify"],
    releaseRunnerLabel: "release",
    baseBranch: "main",
    nextCutAt: null,
    issues: [ENTRY],
    ...over,
  };
}

/** Drop a key rather than set it undefined — that is what a rename looks like. */
function without(key: string) {
  const raw = body() as Record<string, unknown>;
  delete raw[key];
  return raw;
}

describe("parseReleaseRoster", () => {
  it("reads a well-formed response", () => {
    expect(parseReleaseRoster(body(), ENDPOINT)).toEqual({
      gateStatus: "tested",
      channels: ["coolify"],
      releaseRunnerLabel: "release",
      baseBranch: "main",
      nextCutAt: null,
      issues: [ENTRY],
    });
  });

  it("reads an empty channel list as an empty channel list", () => {
    expect(parseReleaseRoster(body({ channels: [] }), ENDPOINT).channels).toEqual([]);
  });

  it("keeps every channel where a project declares several", () => {
    const parsed = parseReleaseRoster(body({ channels: ["coolify", "vercel"] }), ENDPOINT);
    expect(parsed.channels).toEqual(["coolify", "vercel"]);
  });

  it("refuses a response with no channels, naming the endpoint, the key and the type", () => {
    let thrown: unknown;
    try {
      parseReleaseRoster(without("channels"), ENDPOINT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RosterShapeError);
    const message = (thrown as Error).message;
    expect(message).toContain(ENDPOINT);
    expect(message).toContain("channels");
    expect(message).toContain("an array of strings");
    expect(message).toContain("no such key");
  });

  it("refuses the renamed key it was actually fixed for, rather than reading it", () => {
    const raw = without("channels");
    raw.channel = "coolify";
    expect(() => parseReleaseRoster(raw, ENDPOINT)).toThrow(/channels/);
  });

  it("refuses a wrong-typed channels", () => {
    expect(() => parseReleaseRoster(body({ channels: "coolify" }), ENDPOINT)).toThrow(
      /channels should be an array of strings/,
    );
  });

  it("refuses a channel element that is not a string, naming its index", () => {
    expect(() => parseReleaseRoster(body({ channels: ["coolify", 7] }), ENDPOINT)).toThrow(
      /channels\[1\] should be a string/,
    );
  });

  it("refuses a nullable key that is absent rather than null", () => {
    expect(() => parseReleaseRoster(without("nextCutAt"), ENDPOINT)).toThrow(
      /nextCutAt should be a string or null/,
    );
  });

  it("refuses an absent issues list", () => {
    expect(() => parseReleaseRoster(without("issues"), ENDPOINT)).toThrow(
      /issues should be an array/,
    );
  });

  it("refuses a malformed entry, naming its position and key", () => {
    const raw = body({ issues: [ENTRY, { ...ENTRY, displayId: 12 }] });
    expect(() => parseReleaseRoster(raw, ENDPOINT)).toThrow(
      /issues\[1\]\.displayId should be a string/,
    );
  });

  it("refuses an entry whose waitingDays is a string", () => {
    const raw = body({ issues: [{ ...ENTRY, waitingDays: "2" }] });
    expect(() => parseReleaseRoster(raw, ENDPOINT)).toThrow(
      /issues\[0\]\.waitingDays should be a number or null/,
    );
  });

  it("refuses a response that is not an object at all", () => {
    expect(() => parseReleaseRoster(null, ENDPOINT)).toThrow(/the response should be an object/);
    expect(() => parseReleaseRoster([body()], ENDPOINT)).toThrow(
      /the response should be an object/,
    );
  });
});
