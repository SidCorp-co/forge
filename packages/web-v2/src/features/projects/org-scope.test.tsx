// @vitest-environment jsdom
//
// ISS-34 — a project the caller reaches by a project invite alone, in an org they are not a
// member of, is in no org they can switch to. It shows under the active org rather than under
// none, so Chat lists its rooms and the console lists the project it counts.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectConsoleItem, ProjectListItem } from "./types";

const PERSONAL = "o-personal";
const OTHER = "o-other";

vi.mock("@/features/orgs/active-org", () => ({ useActiveOrg: () => ({ activeOrgId: PERSONAL }) }));
vi.mock("./pins", () => ({ usePinnedProjects: () => ({ pinnedIds: new Set(), toggle: vi.fn() }) }));

function project(id: string, orgId: string, orgRole: ProjectListItem["orgRole"]): ProjectListItem {
  return {
    id,
    slug: id,
    name: id,
    orgId,
    orgName: orgId,
    orgIsPersonal: orgId === PERSONAL,
    createdBy: "u1",
    role: "member",
    orgRole,
    archivedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
  };
}

const MINE = project("mine", PERSONAL, "owner");
const INVITED = project("invited", OTHER, null);
const OTHER_ORG = project("other-org", OTHER, "member");

vi.mock("./api", () => ({
  projectApi: { list: vi.fn(async () => [MINE, INVITED, OTHER_ORG]), health: vi.fn(async () => []) },
}));

const { useOrgScopedProjects } = await import("./hooks");
const { filterProjects, mergeProjects } = await import("./derive");

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("a project in an org the caller is not a member of", () => {
  it("is among the active org's projects, and a project of another org the caller is in is not", async () => {
    const { result } = renderHook(() => useOrgScopedProjects(), { wrapper });
    await waitFor(() => expect(result.current.projects.length).toBeGreaterThan(0));
    expect(result.current.projects.map((p) => p.id)).toEqual(["mine", "invited"]);
  });

  it("is listed by the console under the active org", () => {
    const items: ProjectConsoleItem[] = mergeProjects([MINE, INVITED, OTHER_ORG], [], new Set());
    expect(filterProjects(items, "", false, PERSONAL).map((p) => p.id)).toEqual(["mine", "invited"]);
  });
});
