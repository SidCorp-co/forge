import { describe, expect, it } from "vitest";
import { readSessionModel } from "./session-model";
import { MODEL_TIERS } from "./types";

describe("readSessionModel", () => {
  it("reads every tier the shared enum declares", () => {
    for (const tier of MODEL_TIERS) {
      expect(readSessionModel({ model: tier })).toBe(tier);
    }
  });

  it("shows nothing for a value core would refuse to dispatch", () => {
    expect(readSessionModel({ model: "gpt-4" })).toBeNull();
    expect(readSessionModel({ model: "Opus" })).toBeNull();
    expect(readSessionModel({ model: "claude-opus-5" })).toBeNull();
  });

  it("treats a missing or malformed marker as no selection", () => {
    expect(readSessionModel(null)).toBeNull();
    expect(readSessionModel(undefined)).toBeNull();
    expect(readSessionModel({})).toBeNull();
    expect(readSessionModel({ model: 42 })).toBeNull();
    expect(readSessionModel({ model: null })).toBeNull();
  });

  it("does not confuse an inherited Object.prototype key for a tier", () => {
    expect(readSessionModel({ model: "toString" })).toBeNull();
    expect(readSessionModel({ model: "constructor" })).toBeNull();
  });
});
