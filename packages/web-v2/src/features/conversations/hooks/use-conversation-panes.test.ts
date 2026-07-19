import { describe, expect, it } from "vitest";
import {
  DEFAULT_PANE_WIDTH,
  MAX_PANE_WIDTH,
  MIN_PANE_WIDTH,
  PANE_CAP,
  type PaneEntry,
  addPaneEntry,
  clampPaneWidth,
  removePaneEntry,
  resizePaneEntry,
} from "./use-conversation-panes";

function pane(sessionId: string, projectId = "proj-1"): PaneEntry {
  return { sessionId, projectId, width: DEFAULT_PANE_WIDTH };
}

describe("addPaneEntry", () => {
  it("appends a new pane at the default width", () => {
    const { panes, result } = addPaneEntry([], { sessionId: "s1", projectId: "p1" });
    expect(result).toBe("added");
    expect(panes).toEqual([{ sessionId: "s1", projectId: "p1", width: DEFAULT_PANE_WIDTH }]);
  });

  it("dedupes by sessionId — a second add of the same session is a no-op", () => {
    const first = addPaneEntry([], { sessionId: "s1", projectId: "p1" }).panes;
    const { panes, result } = addPaneEntry(first, { sessionId: "s1", projectId: "p1" });
    expect(result).toBe("exists");
    expect(panes).toBe(first);
  });

  it("rejects a new pane once PANE_CAP is reached", () => {
    let panes: PaneEntry[] = [];
    for (let i = 0; i < PANE_CAP; i++) {
      panes = addPaneEntry(panes, { sessionId: `s${i}`, projectId: "p1" }).panes;
    }
    expect(panes).toHaveLength(PANE_CAP);
    const { panes: after, result } = addPaneEntry(panes, { sessionId: "overflow", projectId: "p1" });
    expect(result).toBe("cap");
    expect(after).toHaveLength(PANE_CAP);
  });
});

describe("removePaneEntry", () => {
  it("drops only the matching pane, keeping the rest", () => {
    const panes = [pane("s1"), pane("s2"), pane("s3")];
    expect(removePaneEntry(panes, "s2")).toEqual([pane("s1"), pane("s3")]);
  });

  it("is a no-op for an unknown sessionId", () => {
    const panes = [pane("s1")];
    expect(removePaneEntry(panes, "unknown")).toEqual(panes);
  });
});

describe("resizePaneEntry / clampPaneWidth", () => {
  it("clamps below MIN_PANE_WIDTH up to the floor", () => {
    expect(clampPaneWidth(100)).toBe(MIN_PANE_WIDTH);
  });

  it("clamps above MAX_PANE_WIDTH down to the ceiling", () => {
    expect(clampPaneWidth(2000)).toBe(MAX_PANE_WIDTH);
  });

  it("leaves an in-range width untouched", () => {
    expect(clampPaneWidth(500)).toBe(500);
  });

  it("resizes only the targeted pane", () => {
    const panes = [pane("s1"), pane("s2")];
    const next = resizePaneEntry(panes, "s2", 600);
    expect(next[0].width).toBe(DEFAULT_PANE_WIDTH);
    expect(next[1].width).toBe(600);
  });
});
