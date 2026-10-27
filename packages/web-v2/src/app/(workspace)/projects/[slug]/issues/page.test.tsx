// @vitest-environment jsdom
//
// ISS-1229 r45, judge-129: a failed project read was headed "Couldn't load" alone, page and tab. r49,
// judge-146: the read that failed is the reader's projects list, so the page names that read.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "desk" }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: undefined, isLoading: false, isError: true, error: new Error("boom") }),
  useRetryProjects: () => () => {},
}));
vi.mock("@/features/issues/components/issues-screen", () => ({ IssuesScreen: () => null }));

const { default: ProjectIssuesPage } = await import("./page");

it("heads a failed project read with what failed, in the page and the tab", () => {
  render(<ProjectIssuesPage />);

  expect(screen.getByRole("heading", { level: 1, name: "Couldn't load your projects" })).toBeInTheDocument();
  expect(document.title).toBe("Couldn't load your projects · Forge");
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});
