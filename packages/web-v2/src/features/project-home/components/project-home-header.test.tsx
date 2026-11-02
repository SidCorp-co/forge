// The project home's header (ISS-903): the project's name is the page's title, in the top bar, with no
// mark or block of its own on the page; its settings are the palette's act.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageCommandsProvider, usePageCommandList } from "@/design";
import { ProjectHomeHeader } from "./project-home-header";

/** The page's palette acts as plain buttons: what ⌘K lists, run by a click. */
function PaletteActs() {
  return usePageCommandList().map((c) => (
    <button key={c.label} type="button" data-palette-act="" onClick={c.onRun}>
      {c.label}
    </button>
  ));
}

const header = (onSettings = () => {}) =>
  render(
    <PageCommandsProvider>
      <ProjectHomeHeader project={{ name: "Hop Clinic API" }} onSettings={onSettings} />
      <PaletteActs />
    </PageCommandsProvider>,
  );

describe("the project home's header", () => {
  it("is the project's name as the page title, and draws no mark", () => {
    const { container } = header();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Hop Clinic API");
    expect(container.querySelector("[data-testid=project-home-header]")).toBeNull();
    expect(screen.queryByText("HC")).toBeNull();
  });

  it("opens the settings from the palette, not from an icon on the page", () => {
    const onSettings = vi.fn();
    header(onSettings);
    expect(screen.queryByRole("button", { name: "Project settings" })?.hasAttribute("data-palette-act")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Project settings" }));
    expect(onSettings).toHaveBeenCalledOnce();
  });
});
