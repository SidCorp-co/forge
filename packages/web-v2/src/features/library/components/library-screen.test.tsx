// @vitest-environment jsdom
//
// ISS-1164 — the Library is one row of peer tabs, and the Memory door that sat in it (and again
// inside Knowledge) is gone: a stale `?tab=memory` address lands on Knowledge, not on a screen.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryScreen } from "./library-screen";

expect.extend(matchers);

vi.mock("next/navigation", () => ({ usePathname: () => "/projects/forge-dev/library" }));
vi.mock("@/features/knowledge/components/knowledge-screen", () => ({
  KnowledgeScreen: () => <p>knowledge screen</p>,
}));
vi.mock("@/features/skills/components/skills-screen", () => ({
  SkillsScreen: () => <p>skills screen</p>,
}));
vi.mock("@/features/skill-updates/components/skill-updates-screen", () => ({
  SkillUpdatesScreen: () => <p>updates screen</p>,
}));

const scope = { projectId: "p1", canManage: true };

function openAt(search: string) {
  window.history.replaceState(null, "", `/projects/forge-dev/library${search}`);
  render(<LibraryScreen scope={scope} />);
}

beforeEach(() => window.history.replaceState(null, "", "/"));
afterEach(cleanup);

describe("Library tabs", () => {
  it("is one row of Knowledge, Skills and Updates and no tab is named Memory", () => {
    openAt("");
    const labels = within(screen.getByRole("tablist"))
      .getAllByRole("tab")
      .map((t) => t.textContent);
    expect(labels).toEqual(["Knowledge", "Skills", "Updates"]);
    expect(screen.getAllByRole("tablist")).toHaveLength(1);
  });

  it("opens Knowledge, not a Memory screen, on a stale ?tab=memory address", () => {
    openAt("?tab=memory");
    expect(screen.getByText("knowledge screen")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Knowledge" })).toHaveAttribute("aria-selected", "true");
  });

  it("still opens Skills and Updates from their addresses", () => {
    openAt("?tab=updates");
    expect(screen.getByText("updates screen")).toBeInTheDocument();
  });
});
