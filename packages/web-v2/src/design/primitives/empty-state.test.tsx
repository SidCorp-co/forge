// @vitest-environment jsdom
//
// ISS-1334: every empty-state action drew a plus, so Clear search and Clear filters read as "add".
// The icon is now the call site's to name.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

expect.extend(matchers);
afterEach(cleanup);

it("draws no icon on an action that names none", () => {
  render(<EmptyState title="No matches" message="Nothing here." action={{ label: "Clear search" }} mascot={false} />);

  expect(screen.getByRole("button", { name: "Clear search" }).querySelector("svg")).toBeNull();
});

it("draws the plus an action that creates something names", () => {
  render(
    <EmptyState
      title="No issues yet"
      message="File the first one."
      action={{ label: "New issue", icon: "plus" }}
      mascot={false}
    />,
  );

  expect(
    screen.getByRole("button", { name: "New issue" }).querySelector("svg.lucide-plus"),
  ).not.toBeNull();
});

it("takes a message with inline markup", () => {
  render(
    <EmptyState
      title="Issue not found"
      message={
        <>
          <code>ISS-9</code> is not here.
        </>
      }
      mascot={false}
    />,
  );

  expect(screen.getByText("ISS-9").tagName).toBe("CODE");
});

// ISS-1229 r44, judge-124: "Project not found" and the other states built on this primitive drew their
// title as a <p>, so a page made of one held no heading.
it("draws its title as a heading, one level under the page's own title by default", () => {
  render(<EmptyState title="No runs on this project" message="A run appears here." mascot={false} />);
  expect(screen.getByRole("heading", { level: 2, name: "No runs on this project" })).toBeTruthy();
});

it("is the page's heading and names the tab where it is the whole page", () => {
  render(<EmptyState level={1} title="Project not found" message="It does not exist." mascot={false} />);
  expect(screen.getByRole("heading", { level: 1, name: "Project not found" })).toBeTruthy();
  expect(document.title).toBe("Project not found · Forge");
  cleanup();
  expect(document.title).toBe("Forge");
});

it("leaves the tab as the page named it where it sits inside a section", () => {
  document.title = "Forge";
  render(<EmptyState title="No runs on this project" message="A run appears here." mascot={false} />);
  expect(document.title).toBe("Forge");
});

// ISS-1229 r45: a page made of one empty state is headed by its title, so it cannot be left out.

// ISS-1229 r45 refused a page-level state with no title; r46 refuses one anywhere. `typecheck:test` is the
// proof: an `@ts-expect-error` that no longer meets an error is itself an error.
it("is refused by the type check where it is given no title, at any level", () => {
  // @ts-expect-error a page-level state is headed by its title
  render(<EmptyState level={1} message="Nothing here." mascot={false} />);
  cleanup();
  // @ts-expect-error every empty state says what is empty in its title
  render(<EmptyState message="Pick an update to review it." mascot={false} />);
  expect(screen.getByText("Pick an update to review it.")).toBeTruthy();
});
