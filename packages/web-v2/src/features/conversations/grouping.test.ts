import { describe, expect, it } from "vitest";
import { dockSections } from "./grouping";

const row = (
  id: string,
  over: { projectId?: string; pinned?: boolean; kind?: string | null; subjectKey?: string | null } = {},
) => ({
  id,
  projectId: over.projectId ?? "hop",
  pinned: over.pinned ?? false,
  kind: over.kind ?? null,
  subjectKey: over.subjectKey ?? null,
});

const names: Record<string, string> = { hop: "HOP", forge: "Forge" };
const opts = (pageKey: string | null) => ({ projectId: "hop", pageKey, projectName: (id: string) => names[id] ?? id });
const shape = (sections: ReturnType<typeof dockSections<ReturnType<typeof row>>>) =>
  sections.map((s) => [s.label, s.rows.map((r) => r.id)]);

describe("the dock's conversation sections", () => {
  it("splits the open project's rooms into Project and This page, by the record the page shows", () => {
    const rows = [row("chat"), row("ba-1", { kind: "requirement", subjectKey: "REQ-1" }), row("ba-6", { subjectKey: "REQ-6" })];
    expect(shape(dockSections(rows, opts("REQ-1")))).toEqual([
      ["Project", ["chat", "ba-6"]],
      ["This page", ["ba-1"]],
    ]);
  });

  it("has no This page section on a page that shows no record", () => {
    const rows = [row("chat"), row("ba-1", { subjectKey: "REQ-1" })];
    expect(shape(dockSections(rows, opts(null)))).toEqual([["Project", ["chat", "ba-1"]]]);
  });

  it("puts the onboarding thread first and pinned rooms next, keeping core's order otherwise", () => {
    const rows = [row("a"), row("b", { pinned: true }), row("c"), row("onb", { kind: "onboarding" })];
    expect(shape(dockSections(rows, opts(null)))).toEqual([["Project", ["onb", "b", "a", "c"]]]);
  });

  it("lists another project's rooms under that project's name, never under Project", () => {
    const rows = [row("f1", { projectId: "forge", subjectKey: "REQ-1" }), row("h1")];
    expect(shape(dockSections(rows, opts("REQ-1")))).toEqual([
      ["Project", ["h1"]],
      ["Forge", ["f1"]],
    ]);
  });

  it("draws nothing for an empty list", () => {
    expect(dockSections([], opts("REQ-1"))).toEqual([]);
  });
});
