// @vitest-environment jsdom
//
// ISS-1229 r49: a sheet was a dialog with no name, so a screen reader announced every one alike.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SlideOver } from "./slide-over";

afterEach(cleanup);

describe("a sheet", () => {
  it("is named by the title it draws", () => {
    render(
      <SlideOver open onClose={vi.fn()} title="Filters">
        <p>body</p>
      </SlideOver>,
    );
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
  });
});
