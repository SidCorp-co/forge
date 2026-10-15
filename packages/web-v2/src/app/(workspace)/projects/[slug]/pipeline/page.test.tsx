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
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({
    data: [{ id: "p1", slug: "forge-dev", role: "viewer" }],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
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
    render(<ProjectPipelinePage />);
    expect(screen.getByText("Project not found")).toBeInTheDocument();
    expect(screen.queryByTestId("screen")).toBeNull();
  });
});
