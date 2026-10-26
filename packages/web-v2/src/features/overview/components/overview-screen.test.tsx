// @vitest-environment jsdom
//
// ISS-1229 r38, judge-103: a plain member of an organization holding seven projects, none of which they
// hold a role on, read "No projects in <org> yet" on the Overview.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noProjectSaid, OverviewScreen } from "./overview-screen";

expect.extend(matchers);
afterEach(cleanup);

let orgRows: { id: string; archivedAt: string | null }[] | undefined;
let orgRead: { isLoading: boolean; isError: boolean };
let elsewhere: unknown[];
let orgAsked: string | undefined;
let pulseFails = false;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/features/orgs/active-org", () => ({
  useActiveOrg: () => ({ activeOrg: { id: "o1", name: "Northwind", slug: "northwind", isPersonal: false }, activeOrgId: "o1" }),
}));
vi.mock("@/features/orgs/workspace-name", () => ({ workspaceName: () => "Northwind" }));
vi.mock("@/features/projects/hooks", () => ({ useProjectsConsole: () => ({ items: elsewhere }) }));
vi.mock("@/features/orgs/hooks", () => ({
  useOrgProjects: (orgId: string | undefined) => {
    orgAsked = orgId;
    return { data: orgId ? orgRows : undefined, ...orgRead };
  },
}));
vi.mock("../hooks", () => ({
  usePulse: () =>
    pulseFails
      ? { isError: true, isLoading: false, error: new Error("The server did not answer."), refetch: vi.fn() }
      : { isError: false, isLoading: false, data: { work: { perProject: [] } } },
}));

beforeEach(() => {
  orgRows = undefined;
  orgRead = { isLoading: false, isError: false };
  elsewhere = [{ id: "x" }];
  orgAsked = undefined;
  pulseFails = false;
});

// ISS-1229 r46: the Overview whose one read failed was headed by nothing, its tab "Forge".
describe("the Overview whose read failed", () => {
  it("is headed by what failed, and the tab names it", () => {
    pulseFails = true;
    render(<OverviewScreen />);
    expect(screen.getByRole("heading", { level: 1, name: "Couldn't load your workspace" })).toBeInTheDocument();
    expect(document.title).toBe("Couldn't load your workspace · Forge");
  });
});

describe("the Overview for a reader who sees none of the organization's projects", () => {
  it("says the organization holds projects they hold no role on, never that it holds none", () => {
    orgRows = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, archivedAt: null }));
    orgRows.push({ id: "gone", archivedAt: "2026-10-01T00:00:00Z" });
    render(<OverviewScreen />);
    expect(orgAsked).toBe("o1");
    expect(screen.getByText("No project in Northwind you can see")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Northwind holds 7 projects, and you hold a role on none of them. An admin of a project can add you to it, or you can start a project of your own.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/yet/);
  });

  it("says the organization has no project yet only where it holds none", () => {
    orgRows = [{ id: "gone", archivedAt: "2026-10-01T00:00:00Z" }];
    render(<OverviewScreen />);
    expect(screen.getByText("No projects in Northwind yet")).toBeInTheDocument();
  });

  it("says nothing of what the organization holds while that is unread", () => {
    orgRead = { isLoading: true, isError: false };
    render(<OverviewScreen />);
    expect(screen.queryByText(/Northwind/)).not.toBeInTheDocument();
    cleanup();
    orgRead = { isLoading: false, isError: true };
    render(<OverviewScreen />);
    expect(screen.getByText("No project in Northwind you can see")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/yet|holds \d/);
  });
});

describe("noProjectSaid", () => {
  it("counts one project in the singular", () => {
    expect(noProjectSaid({ orgLabel: "Northwind", seesProjectsElsewhere: true, unseen: 1 }).message).toBe(
      "Northwind holds 1 project, and you hold a role on none. An admin of a project can add you to it, or you can start a project of your own.",
    );
  });

  it("welcomes a reader who sees no project anywhere and whose organization holds none", () => {
    expect(noProjectSaid({ orgLabel: "Northwind", seesProjectsElsewhere: false, unseen: 0 }).title).toBe("Welcome to Forge");
  });
});
