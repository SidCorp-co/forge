import { describe, expect, it } from "vitest";
import { sidebarSections } from "./grouping";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const row = (id: string, over: { pinned?: boolean; shape?: string; updatedAt?: string } = {}) => ({
  id,
  shape: over.shape ?? "direct",
  pinned: over.pinned ?? false,
  updatedAt: over.updatedAt ?? "2026-10-01T11:00:00Z",
});

describe("the chat sidebar's sections", () => {
  it("lists pinned rooms first, then rooms with other people, then the rest by date, each room once", () => {
    const sections = sidebarSections(
      [row("a"), row("b", { pinned: true, shape: "group" }), row("c", { shape: "group" }), row("d", { updatedAt: "2026-08-01T00:00:00Z" })],
      NOW,
    );
    expect(sections.map((s) => [s.key, s.rows.map((r) => r.id)])).toEqual([
      ["pinned", ["b"]],
      ["shared", ["c"]],
      ["today", ["a"]],
      ["older", ["d"]],
    ]);
  });

  it("has no pinned or shared section when nothing is in one", () => {
    expect(sidebarSections([row("a")], NOW).map((s) => s.key)).toEqual(["today"]);
  });
});
