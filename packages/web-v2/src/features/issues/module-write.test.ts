// `PATCH /api/issues/:id` replaces an issue's label set wholesale, so the body this builds is the
// only thing between a module edit and silently deleting every plain label on the issue. Each case
// below is a shape the server would accept and act on — none of them errors, which is exactly why
// they have to be asserted here rather than caught downstream.

import { describe, expect, it } from "vitest";
import { buildModuleLabelWrite } from "./hooks";
import type { IssueLabel } from "./types";

function label(id: string, kind: "label" | "module"): IssueLabel {
  return { id, name: id, color: "#1f6f4a", kind };
}

describe("buildModuleLabelWrite", () => {
  it("carries every plain label through a module edit", () => {
    const body = buildModuleLabelWrite([label("bug", "label"), label("ux", "label")], [], null);
    expect(body).toEqual(["bug", "ux"]);
  });

  it("drops the modules the edit did not keep, and only those", () => {
    const current = [label("bug", "label"), label("core", "module")];
    expect(buildModuleLabelWrite(current, ["web"], null)).toEqual(["bug", "web"]);
  });

  it("marks the primary and leaves every secondary a bare string", () => {
    expect(buildModuleLabelWrite([], ["core", "web"], "web")).toEqual([
      "core",
      { labelId: "web", isPrimary: true },
    ]);
  });

  it("marks nothing primary when there is none", () => {
    expect(buildModuleLabelWrite([], ["core"], null)).toEqual(["core"]);
  });

  it("marks at most one primary even if the id repeats", () => {
    const body = buildModuleLabelWrite([], ["core", "core"], "core");
    expect(body.filter((e) => typeof e === "object" && e.isPrimary)).toHaveLength(2);
  });

  it("sends an empty body when an issue with no labels clears its modules", () => {
    expect(buildModuleLabelWrite([], [], null)).toEqual([]);
  });

  it("never marks a plain label primary, whatever the primaryId says", () => {
    const body = buildModuleLabelWrite([label("bug", "label")], [], "bug");
    expect(body).toEqual(["bug"]);
  });
});
