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

vi.mock("@/features/projects/hooks", () => ({
  useProjectsIncludingArchived: () => ({ data: rows, isLoading: false }),
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
