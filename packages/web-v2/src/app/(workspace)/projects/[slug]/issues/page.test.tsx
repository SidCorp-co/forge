// @vitest-environment jsdom
//
// ISS-1229 r45 and r49: a failed projects read heads the page and the tab with the read that failed.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

const retried = vi.fn();
vi.mock("next/navigation", () => ({ useParams: () => ({ slug: "desk" }) }));
vi.mock("@/features/projects/hooks", () => ({
  useProjects: () => ({ data: undefined, isLoading: false, isError: true, error: new Error("boom") }),
  useRetryProjects: () => retried,
}));
vi.mock("@/features/issues/components/issues-screen", () => ({ IssuesScreen: () => null }));

const { default: ProjectIssuesPage } = await import("./page");

it("heads a failed project read with what failed, in the page and the tab", () => {
  render(<ProjectIssuesPage />);

  expect(screen.getByRole("heading", { level: 1, name: "Couldn't load your projects" })).toBeInTheDocument();
  expect(document.title).toBe("Couldn't load your projects · Forge");
  expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
});

// ISS-1229 r55, judge-170: New issue pressed while the projects could not be read only added `?new=1`.
it("opens New issue while the projects cannot be read, saying why, with Retry under the one rule", () => {
  window.history.replaceState(null, "", "/projects/desk/issues?new=1&status=open");
  render(<ProjectIssuesPage />);

  const sheet = screen.getByRole("dialog", { name: "New issue" });
  expect(within(sheet).getByRole("heading", { name: "No project to create it in" })).toBeInTheDocument();
  expect(sheet).toHaveTextContent("Your projects could not be read, so this project cannot be offered for the new issue.");
  fireEvent.click(within(sheet).getByRole("button", { name: "Retry" }));
  expect(retried).toHaveBeenCalledTimes(1);

  fireEvent.click(within(sheet).getByRole("button", { name: /close/i }));
  expect(window.location.search).toBe("?status=open");
  expect(screen.queryByRole("dialog", { name: "New issue" })).toBeNull();
});
