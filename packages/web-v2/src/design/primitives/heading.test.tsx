// @vitest-environment jsdom
//
// ISS-1229 r47, judge-137: Runners, Org, Settings and Usage each headed the page with one title while the
// tab read "Forge". The page's h1 names the tab with the text it shows, so the two cannot disagree.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PageTitle } from "./heading";

beforeEach(() => {
  document.title = "Forge";
});
afterEach(cleanup);

describe("the page's title", () => {
  it("is the page's h1 and names the tab with the text it shows", () => {
    render(
      <PageTitle>
        Runners <span>&amp;</span> devices
      </PageTitle>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Runners & devices");
    expect(document.title).toBe("Runners & devices · Forge");
  });

  it("names the tab anew when what it shows changes, and lets the tab go when it leaves", () => {
    const { rerender, unmount } = render(<PageTitle>Overview</PageTitle>);
    rerender(<PageTitle>Overview · Desk</PageTitle>);
    expect(document.title).toBe("Overview · Desk · Forge");
    unmount();
    expect(document.title).toBe("Forge");
  });

  it("heads nothing and names no tab where a state heads the page instead", () => {
    render(<PageTitle heads={false}>Usage</PageTitle>);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Usage").tagName).toBe("P");
    expect(document.title).toBe("Forge");
  });
});
