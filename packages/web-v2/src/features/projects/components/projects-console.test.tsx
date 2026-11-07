// The projects page counts one set and lists it whole at phone width (ISS-1072 round 2). On forge-dev,
// 2026-11-07, the header said "3 projects" while the list said "All projects 2": the band summed every
// project the viewer can read, the list only the active organization's. And at 390px the table's
// cells wrapped letter by letter ("0 / live / runs"). The band now counts the list's own set, and a
// phone draws the shared row list in place of the table.
// @direct-test-of packages/web-v2/src/features/projects/hooks.ts

import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithQuery } from "@/test/render";
import type { ProjectConsoleItem } from "../types";
import { ProjectsConsole } from "./projects-console";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

const item = (id: string, name: string, orgId: string): ProjectConsoleItem => ({
  id,
  slug: name.toLowerCase(),
  name,
  orgId,
  orgName: orgId === "o1" ? "SidCorp" : "Personal",
  orgIsPersonal: orgId !== "o1",
  role: "admin",
  orgRole: "owner",
  createdAt: "2026-10-01T00:00:00.000Z",
  health: "healthy",
  liveRuns: 0,
  openIssues: 3,
  runnerCount: 1,
  spend24hUsd: 0,
  memberCount: 1,
  members: [],
  lastActivityAt: null,
  pinned: false,
});

const ITEMS = [item("p1", "Forge", "o1"), item("p2", "Agenfold", "o1"), item("p3", "Sandbox", "o2")];

vi.mock("../hooks", async (orig) => ({
  ...(await orig<typeof import("../hooks")>()),
  useProjectsConsole: () => ({ items: ITEMS, isLoading: false, isError: false, error: null, refetch: () => {}, toggle: () => {} }),
}));
vi.mock("@/features/orgs", async (orig) => ({
  ...(await orig<typeof import("@/features/orgs")>()),
  useActiveOrg: () => ({ orgs: [], activeOrg: { id: "o1", name: "SidCorp", isPersonal: false }, activeOrgId: "o1", setActiveOrg: () => {}, isSingle: false, resolved: true }),
}));

const phone = (narrow: boolean) =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow && query.includes("max-width"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));

afterEach(() => vi.unstubAllGlobals());

describe("the projects page", () => {
  it("counts in its header the projects its list shows", () => {
    phone(false);
    renderWithQuery(<ProjectsConsole />);
    expect(screen.getByText("2 projects")).toBeInTheDocument();
    expect(screen.queryByText("3 projects")).toBeNull();
    expect(screen.getAllByRole("row").length - 1).toBe(2);
  });

  it("draws the shared row list at phone width, no table", () => {
    phone(true);
    renderWithQuery(<ProjectsConsole />);
    expect(screen.queryByRole("table")).toBeNull();
    const list = screen.getByTestId("projects-rows");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(/Forge|Agenfold/);
  });
});
