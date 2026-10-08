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
  render(<EmptyState message="Nothing here." action={{ label: "Clear search" }} mascot={false} />);

  expect(screen.getByRole("button", { name: "Clear search" }).querySelector("svg")).toBeNull();
});

it("draws the plus an action that creates something names", () => {
  render(
    <EmptyState message="No issues yet." action={{ label: "New issue", icon: "plus" }} mascot={false} />,
  );

  expect(
    screen.getByRole("button", { name: "New issue" }).querySelector("svg.lucide-plus"),
  ).not.toBeNull();
});

it("takes a message with inline markup", () => {
  render(
    <EmptyState
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
