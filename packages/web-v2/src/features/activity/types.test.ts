import { describe, expect, it } from "vitest";
import {
  formatTokens,
  ratingTone,
  sumTokens,
  type ChatLogRow,
} from "./types";

function row(usage: ChatLogRow["usage"]): ChatLogRow {
  return {
    id: "x",
    sessionId: "s",
    projectSlug: "p",
    userKey: null,
    query: "q",
    reply: null,
    model: null,
    ragContext: null,
    toolCalls: null,
    usage,
    iterations: 1,
    durationMs: null,
    error: null,
    queryIntent: null,
    condensedQuery: null,
    source: "web",
    qualitySignals: null,
    qaRating: null,
    qaNotes: null,
    createdAt: "2026-05-31T00:00:00.000Z",
  };
}

describe("formatTokens", () => {
  it("buckets", () => {
    expect(formatTokens(null)).toBe("0");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(942)).toBe("942");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(2_000_000)).toBe("2.0M");
  });
});

describe("sumTokens", () => {
  it("sums input/output across rows, tolerating null usage", () => {
    const rows = [
      row({ input_tokens: 100, output_tokens: 20 }),
      row({ input_tokens: 50 }),
      row(null),
    ];
    expect(sumTokens(rows)).toEqual({ input: 150, output: 20 });
  });
});

describe("ratingTone", () => {
  it("maps ratings to badge tones", () => {
    expect(ratingTone("good")).toBe("green");
    expect(ratingTone("bad")).toBe("red");
    expect(ratingTone("flagged")).toBe("amber");
  });
});
