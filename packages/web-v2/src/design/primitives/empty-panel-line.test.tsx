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

  it("holds a fixed single-line height", () => {
    render(<EmptyPanelLine title="Steps" status="None yet" />);
    expect(screen.getByRole("region", { name: "Steps" }).className).toContain("h-10");
  });

  it("never shrinks the title or the status, so the detail is what yields", () => {
    render(<EmptyPanelLine title="Awaiting release" status="None waiting" detail="A person releases" />);
    expect(screen.getByRole("heading", { name: "Awaiting release" }).className).toContain("shrink-0");
    expect(screen.getByText("None waiting").className).toContain("shrink-0");
    const detail = screen.getByText("A person releases");
    expect(detail.className).toContain("truncate");
    expect(detail.className).toContain("min-w-0");
    expect(detail.getAttribute("title")).toBe("A person releases");
  });

  it("renders no separator for a detail it was not given", () => {
    render(<EmptyPanelLine title="Steps" status="None yet" />);
    expect(screen.getByRole("region", { name: "Steps" }).textContent).toBe("Steps·None yet");
  });
});
