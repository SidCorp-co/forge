// The projects table reads whole (ISS-1072 round 3, projects-d on dev.571): the last activity time sat
// under no header ("2m" beside an empty Spend heading while every cost was $0), and the Team stack
// drew each avatar over the one before it, its initials cut to "O(", "Q/". Every column has a header,
// and the stack draws each avatar whole, none laid over another.
// @direct-test-of packages/web-v2/src/features/projects/components/project-list.tsx
// @direct-test-of packages/web-v2/src/features/projects/components/member-stack.tsx

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectConsoleItem } from "../types";
import { MemberStack } from "./member-stack";
import { ProjectList } from "./project-list";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const NOW = Date.parse("2026-11-07T08:00:00.000Z");
const item = (id: string, name: string): ProjectConsoleItem => ({
  id,
  slug: name.toLowerCase(),
  name,
  orgId: "o1",
  orgName: "SidCorp",
  orgIsPersonal: false,
  role: "admin",
  orgRole: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
  health: "healthy",
  liveRuns: 0,
  openIssues: 74,
  runnerCount: 1,
  spend24hUsd: 0,
  memberCount: 4,
  members: ["OR", "QA", "FO", "ST"],
  lastActivityAt: "2026-11-07T07:58:00.000Z",
  pinned: false,
});

describe("the projects table", () => {
  it.each([false, true])("names every column it draws, spend shown: %s", (spend) => {
    render(<ProjectList items={[item("p1", "Forge")]} now={NOW} spend={spend} onTogglePin={() => {}} />);
    const heads = screen.getAllByRole("columnheader");
    const cells = within(screen.getAllByRole("row")[1] ?? document.body).getAllByRole("cell");
    expect(heads).toHaveLength(cells.length);
    // the mark's column is the project's own picture, named with the project; every other heading is 1-3 words
    for (const h of heads.slice(1)) {
      const words = (h.textContent ?? "").trim().split(/\s+/).filter(Boolean).length;
      expect(words, `heading "${h.textContent}"`).toBeGreaterThanOrEqual(1);
      expect(words).toBeLessThanOrEqual(3);
    }
    expect(heads.some((h) => h.textContent?.trim() === "Spend")).toBe(spend);
    // the time the project last moved reads under its own heading
    const timeAt = cells.findIndex((c) => c.textContent?.includes("2m"));
    expect(timeAt).toBeGreaterThan(0);
    expect(heads[timeAt]?.textContent?.trim()).toBe("Active");
  });
});

describe("a project's team stack", () => {
  it("draws every avatar whole, none laid over the one before it", () => {
    const { container } = render(<MemberStack members={["OR", "QA", "FO", "ST"]} total={6} size={22} />);
    const marks = [...container.querySelectorAll<HTMLElement>("[data-testid=member-avatar]")];
    expect(marks.map((m) => m.textContent)).toEqual(["OR", "QA", "FO", "ST"]);
    for (const m of marks) expect(Number.parseFloat(m.style.marginLeft || "0")).toBeGreaterThanOrEqual(0);
    expect(container.textContent).toContain("+2");
  });
});
