// @vitest-environment jsdom
//
// ISS-1229 r16, judge-41: an archived project's own page said "This project doesn't exist". It says
// the project is archived and when, and offers its admin the way back.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

let rows: Array<Record<string, unknown>> = [];
const mutate = vi.fn();
const listRead = vi.hoisted(() => ({ failed: false, refetch: () => {} }));

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "no-such-board" }) }));
vi.mock("@/features/projects/hooks", () => ({
  useRetryProjects: () => listRead.refetch,
  useProjects: () =>
    listRead.failed
      ? { data: undefined, isLoading: false, isError: true, error: new Error("The server is down.") }
      : { data: rows, isLoading: false, isError: false, error: null },
  useProjectsIncludingArchived: () =>
    listRead.failed
      ? { data: undefined, isLoading: false, isError: true, error: new Error("The server is down."), refetch: listRead.refetch }
      : { data: rows, isLoading: false, isError: false, error: null, refetch: listRead.refetch },
}));
vi.mock("@/features/project-settings/hooks", () => ({
  useUnarchiveProject: () => ({ mutate, isPending: false }),
}));

const { ProjectMissing } = await import("./project-missing");

const ARCHIVED = {
  id: "p9",
  slug: "old-board",
  name: "Old board",
  archivedAt: "2026-10-18T07:30:33Z",
};

describe("a project page whose slug the live list lacks", () => {
  it("offers an org admin the way back from an archived project", () => {
    rows = [{ ...ARCHIVED, orgRole: "admin" }];
    render(<ProjectMissing slug="old-board" />);
    expect(screen.getByText("This project is archived")).toBeInTheDocument();
    expect(screen.getByText(/Unarchive it to work on it again\.$/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive project" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("says not found where no project, live or archived, has the slug", () => {
    rows = [{ ...ARCHIVED, orgRole: "admin" }];
    render(<ProjectMissing slug="never-was" />);
    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByText("This project is archived")).toBeNull();
  });
});

// ISS-1229 r44, judge-124: /projects/<no such project>/issues showed "Project not found" as a paragraph and
// left the tab reading "Forge". The page is that one state, so its title heads the page and names the tab.
describe("the page a missing or archived project shows", () => {
  it.each([
    ["not found", "never-was", "admin", "Project not found"],
    ["archived, to an admin", "old-board", "admin", "This project is archived"],
    ["archived, to a member", "old-board", "member", "This project is archived"],
  ])("heads the page with its title and names the tab where it is %s", (_case, slug, orgRole, title) => {
    rows = [{ ...ARCHIVED, orgRole }];
    render(<ProjectMissing slug={slug} />);
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    expect(document.title).toBe(`${title} · Forge`);
  });
});

// ISS-1229 r48: with the projects list failing to load, a project's own address said "Project not found".
describe("a project page whose projects list could not be read", () => {
  it("says the projects could not be loaded, never that the project is not found, and Retry reads them again", () => {
    listRead.failed = true;
    const refetch = vi.fn();
    listRead.refetch = refetch;
    render(<ProjectMissing slug="old-board" />);
    expect(screen.queryByText("Project not found")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Couldn't load your projects" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    listRead.failed = false;
  });
});

// ISS-1229 r49, judge-146: with the projects list failing, every page under a project's address said
// "Couldn't load this project", naming a read that never ran.
describe("a page under a project's address whose projects list could not be read", () => {
  const pages = [
    ["issues", () => import("@/app/(workspace)/projects/[slug]/issues/page")],
    ["agents", () => import("@/app/(workspace)/projects/[slug]/agents/page")],
    ["library", () => import("@/app/(workspace)/projects/[slug]/library/page")],
    ["pipeline", () => import("@/app/(workspace)/projects/[slug]/pipeline/page")],
    ["automation", () => import("@/app/(workspace)/projects/[slug]/automation/page")],
  ] as const;

  it.each(pages)("names the projects read on the %s page, with a Retry that reads it again", async (_name, load) => {
    listRead.failed = true;
    const refetch = vi.fn();
    listRead.refetch = refetch;
    const Page = (await load()).default;
    render(<Page />);
    expect(screen.getByRole("heading", { level: 1, name: "Couldn't load your projects" })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load this project")).toBeNull();
    expect(screen.queryByText("Project not found")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    listRead.failed = false;
  });
});
