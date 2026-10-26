// @vitest-environment jsdom
//
// ISS-1229 r44, judge-124: an unknown address showed "Page not found" as a paragraph, and the tab read
// "Forge". The page is one error state, so its title is the page's heading and names the tab.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import NotFound from "./not-found";

expect.extend(matchers);
afterEach(cleanup);

describe("the page an unknown address shows", () => {
  it("heads the page with its title, names the tab after it, and leads home", () => {
    render(<NotFound />);

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(document.title).toBe("Page not found · Forge");
    expect(screen.getByRole("link", { name: "Back to home" })).toHaveAttribute("href", "/");
  });
});
