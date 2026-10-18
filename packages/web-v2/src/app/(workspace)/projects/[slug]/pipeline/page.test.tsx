// @vitest-environment jsdom
//
// ISS-1228 — the pipeline page resolves its project from the slug and renders the sessions-and-holds
// screen for it; a slug no project answers to is said by name.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectPipelinePage from "./page";

expect.extend(matchers);
afterEach(cleanup);

let slug = "forge-dev";

vi.mock("next/navigation", () => ({ useParams: () => ({ slug }) }));
let archived: Array<Record<string, unknown>> = [];
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({
    data: [{ id: "p1", slug: "forge-dev", role: "viewer" }],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useProjectsIncludingArchived: () => ({ data: archived, isLoading: false }),
}));
vi.mock("@/features/pipeline/components/pipeline-screen", () => ({
  PipelineScreen: ({ scope }: { scope: { projectId: string; slug: string } }) => (
    <div data-testid="screen" data-project={scope.projectId} data-slug={scope.slug} />
  ),
}));

describe("the pipeline page", () => {
  it("renders the screen for the project the slug names", () => {
    slug = "forge-dev";
    render(<ProjectPipelinePage />);
    expect(screen.getByTestId("screen")).toHaveAttribute("data-project", "p1");
  });

  it("says a slug no project answers to is not found", () => {
    slug = "nope";
    archived = [];
    render(<ProjectPipelinePage />);
    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByTestId("screen")).toBeNull();
  });

  // ISS-1229 r16, judge-41: an archived project's page said "This project doesn't exist".
  it("says an archived project is archived, when, and who can bring it back", () => {
    slug = "old-board";
    archived = [
      {
        id: "p9",
        slug: "old-board",
        name: "Old board",
        orgRole: "member",
        archivedAt: "2026-10-18T07:30:33Z",
      },
    ];
    render(<ProjectPipelinePage />);
    expect(screen.getByText("This project is archived")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Old board was archived on Oct 18, 2026. Its issues, comments, runs and sessions are all kept. An admin of its organization can unarchive it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Project not found")).toBeNull();
    expect(screen.queryByRole("button", { name: "Unarchive project" })).toBeNull();
  });
});
