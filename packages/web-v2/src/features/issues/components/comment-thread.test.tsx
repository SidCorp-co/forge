// ISS-1421 r39: newest first is the thread's own order turned round, a pair inside one millisecond included.

import { describe, expect, it } from "vitest";
import { newestFirst } from "./comment-thread";

const at = (id: string, createdAt: string) => ({ id, createdAt });

describe("newestFirst", () => {
  it("turns the thread's order round exactly, a pair inside one millisecond included", () => {
    const thread = [
      at("a", "2026-10-28T09:00:00.000Z"),
      at("b", "2026-10-28T09:00:01.000Z"),
      at("c", "2026-10-28T09:00:01.000Z"),
    ];
    expect(newestFirst(thread).map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("puts a later comment first wherever it arrived in the list, and leaves the list it read alone", () => {
    const thread = [at("late", "2026-10-28T10:00:00.000Z"), at("early", "2026-10-28T09:00:00.000Z")];
    expect(newestFirst(thread).map((c) => c.id)).toEqual(["late", "early"]);
    expect(thread.map((c) => c.id)).toEqual(["late", "early"]);
  });
});
