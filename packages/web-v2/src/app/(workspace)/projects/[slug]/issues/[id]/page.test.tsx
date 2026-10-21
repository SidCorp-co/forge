// @vitest-environment jsdom
//
// ISS-1228 r27 (criterion 257): once a deleted project left the projects list, its open issue page
// said "Issue not found · This project or issue doesn't exist" where its Pipeline page said the
// project was not found.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectIssueDetailPage from "./page";

expect.extend(matchers);
afterEach(cleanup);

let slug = "forge-dev";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug, id: "ISS-7" }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({
    data: [{ id: "p1", slug: "forge-dev", role: "admin" }],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useProjectsIncludingArchived: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/features/issues/components/issue-detail-screen", () => ({
  IssueDetailScreen: ({ projectId, id }: { projectId: string; id: string }) => (
    <div data-testid="screen" data-project={projectId} data-issue={id} />
  ),
}));

describe("the issue page's route", () => {
  it("renders the issue of the project the slug names", () => {
    slug = "forge-dev";
    render(<ProjectIssueDetailPage />);
    expect(screen.getByTestId("screen")).toHaveAttribute("data-project", "p1");
  });

  it("says the project was not found where no project answers to the slug, as the Pipeline page does", () => {
    slug = "gone";
    render(<ProjectIssueDetailPage />);
    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.getByText("This project doesn't exist or you don't have access to it.")).toBeInTheDocument();
    expect(screen.queryByText("Issue not found")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
