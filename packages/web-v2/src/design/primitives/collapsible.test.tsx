// @vitest-environment jsdom
import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Collapsible } from "./collapsible";

expect.extend(matchers);
afterEach(cleanup);

/** Every class a disclosure and what it holds carries, so a box drawn anywhere in it shows. */
function classesOf(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
}

describe("Collapsible", () => {
  it("is a bordered rounded box by default", () => {
    const { container } = render(<Collapsible title="Agent plan">body</Collapsible>);
    const classes = classesOf(container);
    expect(classes).toContain("border");
    expect(classes).toContain("rounded-md");
  });

  it("draws no box when flat, open or shut, so the page's own hairlines rule a stack of them", () => {
    const { container } = render(
      <Collapsible flat title="Open stage">
        body
      </Collapsible>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Open stage/ }));
    expect(screen.getByText("body")).toBeInTheDocument();

    const classes = classesOf(container);
    expect(classes.filter((c) => c === "border" || c.startsWith("rounded") || c.startsWith("bg-"))).toEqual([]);
  });

  it("opens and shuts the same way flat", () => {
    render(
      <Collapsible flat title="Stage">
        body
      </Collapsible>,
    );
    const toggle = screen.getByRole("button", { name: /Stage/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.queryByText("body")).toBeNull();
  });
});
