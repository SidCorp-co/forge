// @vitest-environment jsdom

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button, SecondaryRegion } from "./button";

expect.extend(matchers);
afterEach(cleanup);

describe("a primary button inside a region beside the page", () => {
  it("keeps the page's one primary colour outside any region", () => {
    render(<Button variant="primary">Approve release</Button>);
    expect(screen.getByRole("button", { name: "Approve release" })).toHaveClass("bg-primary");
  });

  it("draws a primary asked for inside the region as a secondary", () => {
    render(
      <SecondaryRegion>
        <Button variant="primary">Send</Button>
      </SecondaryRegion>,
    );
    const send = screen.getByRole("button", { name: "Send" });
    expect(send).not.toHaveClass("bg-primary");
    expect(send).toHaveClass("bg-surface");
  });

  it("leaves every other variant as asked inside the region", () => {
    render(
      <SecondaryRegion>
        <Button variant="danger">Delete</Button>
      </SecondaryRegion>,
    );
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("text-[color:var(--red-600)]");
  });
});
