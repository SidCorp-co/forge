// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

expect.extend(matchers);
afterEach(cleanup);

let query = "";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));

const { DocsScreen } = await import("./docs-screen");

function open(search: string) {
  query = search;
  return render(<DocsScreen />);
}

function breadcrumb(): string | null {
  return screen.queryByRole("navigation", { name: "Breadcrumb" })?.textContent ?? null;
}

describe("the Docs screen opened from a link", () => {
  it("opens the page the link names", () => {
    open("path=what-done-means");
    expect(breadcrumb()).toContain("Tell when an issue is done");
  });

  it("opens the first page when no page is asked for", () => {
    open("");
    expect(breadcrumb()).toContain("Getting started");
  });

  it("says a page does not exist instead of showing a different one", () => {
    open("path=no-such-page");
    expect(screen.getByText("No such help page")).toBeInTheDocument();
    expect(screen.getByText(/No help page is called "no-such-page"/)).toBeInTheDocument();
    expect(breadcrumb()).toBeNull();
  });

  it("says a link naming no page names none", () => {
    open("path=");
    expect(screen.getByText("No such help page")).toBeInTheDocument();
    expect(screen.getByText(/names no help page/)).toBeInTheDocument();
    expect(breadcrumb()).toBeNull();
  });
});
