import { describe, expect, it } from "vitest";
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, clampDockWidth, targetInScope } from "./dock-target";

describe("the chat dock's scope", () => {
  it("is a fresh draft in the selected project when nothing was picked", () => {
    expect(targetInScope(null, "p1")).toEqual({ kind: "draft", projectId: "p1" });
  });

  it("keeps a room or draft of the selected project", () => {
    const room = { kind: "room" as const, projectId: "p1", conversationId: "c1" };
    expect(targetInScope(room, "p1")).toBe(room);
  });

  it("drops a chat of another project for a draft in the one now selected", () => {
    expect(targetInScope({ kind: "room", projectId: "p2", conversationId: "c9" }, "p1")).toEqual({
      kind: "draft",
      projectId: "p1",
    });
  });

  it("keeps a room with other people, which belongs to no project yet", () => {
    expect(targetInScope({ kind: "people" }, "p1")).toEqual({ kind: "people" });
    expect(targetInScope({ kind: "people" }, null)).toEqual({ kind: "people" });
  });

  it("has nothing to open with no project selected", () => {
    expect(targetInScope(null, null)).toBeNull();
    expect(targetInScope({ kind: "draft", projectId: "p1" }, null)).toBeNull();
  });
});

describe("the dock's width", () => {
  it.each([
    [100, DOCK_MIN_WIDTH],
    [DOCK_MIN_WIDTH, DOCK_MIN_WIDTH],
    [500, 500],
    [DOCK_MAX_WIDTH, DOCK_MAX_WIDTH],
    [5000, DOCK_MAX_WIDTH],
    [Number.NaN, 440],
  ])("holds %s at %s", (w, expected) => {
    expect(clampDockWidth(w)).toBe(expected);
  });
});
