// ISS-1156 — the Attention badge states a figure only where the attention read was read in full: an
// undefined count (not yet read, or failed) is carried to every rail as no badge, never as 0.

import { describe, expect, it } from "vitest";
import { bottomTabItems, compactWorkspaceRailItems, workspaceNavItems } from "./nav-model";

describe("the Attention badge", () => {
  it("carries a read count to the rail rows and the bottom bar", () => {
    expect(workspaceNavItems(4).find((i) => i.key === "overview")?.badge).toBe(4);
    expect(compactWorkspaceRailItems(4).find((i) => i.key === "overview")?.badge).toBe(4);
    expect(bottomTabItems(null, 4, undefined).find((i) => i.key === "attention")?.badge).toBe(4);
  });

  it("carries an unread count as no badge on every one of them", () => {
    expect(workspaceNavItems(undefined).find((i) => i.key === "overview")?.badge).toBeUndefined();
    expect(compactWorkspaceRailItems(undefined).find((i) => i.key === "overview")?.badge).toBeUndefined();
    expect(bottomTabItems(null, undefined, undefined).find((i) => i.key === "attention")?.badge).toBeUndefined();
  });
});
