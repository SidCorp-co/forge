// @vitest-environment jsdom
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EmptyPanelLine } from "./empty-panel-line";

expect.extend(matchers);
afterEach(cleanup);

describe("EmptyPanelLine — an empty secondary panel is one line", () => {
  it("names the panel as a region with its title as a heading", () => {
    render(<EmptyPanelLine title="Steps" status="None yet" />);
    const region = screen.getByRole("region", { name: "Steps" });
    expect(region).toContainElement(screen.getByRole("heading", { name: "Steps" }));
    expect(region).toHaveTextContent("None yet");
  });

  it("holds a fixed single-line height from sm up", () => {
    render(<EmptyPanelLine title="Steps" status="None yet" />);
    expect(screen.getByRole("region", { name: "Steps" }).className.split(/\s+/)).toContain("sm:h-10");
  });

  it("never shrinks the title or the status, so the detail is what yields", () => {
    render(<EmptyPanelLine title="Awaiting release" status="None waiting" detail="A person releases" />);
    expect(screen.getByRole("heading", { name: "Awaiting release" }).className).toContain("shrink-0");
    expect(screen.getByText("None waiting").className).toContain("shrink-0");
    const detail = screen.getByText("A person releases");
    expect(detail.className.split(/\s+/)).toContain("sm:truncate");
    expect(detail.className).toContain("min-w-0");
    expect(detail.getAttribute("title")).toBe("A person releases");
  });

  // ISS-1228 r9: at 390 the dashboard's "Nothing in this project needs you right now." read
  // "Nothing in this projec…", and a phone has no hover to show the rest.
  it("wraps its detail below sm instead of cutting it, and keeps one line from sm up", () => {
    render(<EmptyPanelLine title="Needs your attention" status="All caught up" detail="Nothing in this project needs you right now." />);
    const tokens = (el: Element) => el.className.split(/\s+/);
    const region = screen.getByRole("region", { name: "Needs your attention" });
    expect(tokens(region)).toEqual(expect.arrayContaining(["flex-wrap", "sm:flex-nowrap", "sm:h-10"]));
    expect(tokens(region)).not.toContain("h-10");
    const detail = screen.getByText("Nothing in this project needs you right now.");
    expect(tokens(detail)).not.toContain("truncate");
    expect(tokens(detail)).toEqual(expect.arrayContaining(["break-words", "sm:truncate"]));
  });

  it("renders no separator for a detail it was not given", () => {
    render(<EmptyPanelLine title="Steps" status="None yet" />);
    expect(screen.getByRole("region", { name: "Steps" }).textContent).toBe("Steps·None yet");
  });
});
