// @vitest-environment jsdom
//
// ISS-1172: a row menu opened near the bottom of the issues list rendered
// inside the Table's `overflow-hidden` box and showed 36px of 565px. The panel
// now leaves for <body>; these tests pin that it does, and that what the menu
// did inline still holds across the portal: first item focused, an item runs
// and closes, Escape and Tab close and give focus back to the trigger.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Table, TBody, TD, TR } from "@/design/primitives/table";
import { Menu, type MenuItem } from "./menu";

expect.extend(matchers);
afterEach(cleanup);

function InTable({ items }: { items: MenuItem[] }) {
  return (
    <Table data-testid="table">
      <TBody>
        <TR>
          <TD>
            <Menu
              trigger={
                <button type="button" aria-label="Row actions">
                  ⋯
                </button>
              }
              items={items}
            />
          </TD>
        </TR>
      </TBody>
    </Table>
  );
}

const trigger = () => screen.getByRole("button", { name: "Row actions" });

describe("Menu", () => {
  it("opens its panel on <body>, outside the table box that clipped it", () => {
    render(<InTable items={[{ label: "Edit" }]} />);
    fireEvent.click(trigger());
    const menu = screen.getByRole("menu");
    expect(screen.getByTestId("table").parentElement).not.toContainElement(menu);
    expect(document.body).toContainElement(menu);
  });

  it("puts focus on the first item that is not inert", () => {
    render(<InTable items={[{ label: "Blocked", disabled: true }, { label: "Edit" }]} />);
    fireEvent.click(trigger());
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" }));
  });

  it("runs the item clicked and closes", () => {
    const onSelect = vi.fn();
    render(<InTable items={[{ label: "Edit", onSelect }]} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not run an inert item", () => {
    const onSelect = vi.fn();
    render(<InTable items={[{ label: "Blocked", disabled: true, onSelect }]} />);
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("menuitem", { name: "Blocked" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("closes on Escape and gives focus back to the trigger", () => {
    render(<InTable items={[{ label: "Edit" }]} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Tab from the trigger, so the browser moves on from there", () => {
    render(<InTable items={[{ label: "Edit" }]} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("moves between items with the arrow keys", () => {
    render(<InTable items={[{ label: "Edit" }, { label: "Delete", danger: true }]} />);
    fireEvent.click(trigger());
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" }));
  });

  it("closes on a press outside, and toggles from its trigger", () => {
    render(<InTable items={[{ label: "Edit" }]} />);
    fireEvent.click(trigger());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger());
    fireEvent.mouseDown(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("holds the page still while open", () => {
    render(<InTable items={[{ label: "Edit" }]} />);
    fireEvent.click(trigger());
    const e = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    screen.getByTestId("table").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
