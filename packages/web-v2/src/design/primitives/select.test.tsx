// @vitest-environment jsdom
//
// ISS-1172: the listbox rendered inside the trigger's wrapper, so a Select in a
// Table was cut off by the table's `overflow-hidden` box; and the active option
// was named by `aria-activedescendant` on the listbox while focus stayed on the
// combobox, where no assistive technology reads it. These tests pin the wiring:
// the listbox leaves for <body>, the focused combobox names the active option,
// and the keyboard, typeahead and selection keep working across the portal.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "./select";
import { Table, TBody, TD, TR } from "./table";

expect.extend(matchers);
afterEach(cleanup);
// jsdom has no layout; the Select scrolls its active option into view on open.
Element.prototype.scrollIntoView = vi.fn();

const OPTIONS: SelectOption[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "gone", label: "Oldest archived", disabled: true },
  { value: "priority", label: "Priority" },
];

function InTable({ onChange = vi.fn() }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("newest");
  return (
    <Table data-testid="table">
      <TBody>
        <TR>
          <TD>
            <Select
              aria-label="Sort"
              options={OPTIONS}
              value={value}
              onChange={(v) => {
                setValue(v);
                onChange(v);
              }}
            />
          </TD>
        </TR>
      </TBody>
    </Table>
  );
}

const combobox = () => screen.getByRole("combobox", { name: "Sort" });
const activeOption = () => {
  const id = combobox().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id) : null;
};

describe("Select", () => {
  it("opens its listbox on <body>, outside the table box that clipped it", () => {
    render(<InTable />);
    fireEvent.click(combobox());
    const listbox = screen.getByRole("listbox");
    expect(screen.getByTestId("table").parentElement).not.toContainElement(listbox);
    expect(document.body).toContainElement(listbox);
  });

  it("names the active option from the focused combobox while open", () => {
    render(<InTable />);
    combobox().focus();
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(combobox());
    expect(activeOption()).toHaveTextContent("Newest");
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    expect(activeOption()).toHaveTextContent("Oldest");
  });

  it("names no active option while closed", () => {
    render(<InTable />);
    expect(combobox()).not.toHaveAttribute("aria-activedescendant");
  });

  it("skips a disabled option when arrowing", () => {
    render(<InTable />);
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    expect(activeOption()).toHaveTextContent("Priority");
  });

  it("moves to the first enabled option starting with a typed letter", () => {
    render(<InTable />);
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "p" });
    expect(activeOption()).toHaveTextContent("Priority");
    expect(activeOption()).toHaveAttribute("role", "option");
  });

  it("selects the option clicked and closes", () => {
    const onChange = vi.fn();
    render(<InTable onChange={onChange} />);
    fireEvent.click(combobox());
    fireEvent.click(screen.getByRole("option", { name: "Priority" }));
    expect(onChange).toHaveBeenCalledWith("priority");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(combobox()).toHaveTextContent("Priority");
  });

  it("selects the active option on Enter", () => {
    const onChange = vi.fn();
    render(<InTable onChange={onChange} />);
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "ArrowDown" });
    fireEvent.keyDown(combobox(), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("oldest");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("brings the selected option into view as the listbox opens, before any key", () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    function Long() {
      const many = Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Option ${i}` }));
      return <Select aria-label="Long" options={many} value="v29" onChange={vi.fn()} />;
    }
    render(<Long />);
    fireEvent.click(screen.getByRole("combobox", { name: "Long" }));
    expect(scrolled.mock.contexts).toContain(screen.getByRole("option", { name: "Option 29" }));
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("closes on a press outside and on Escape", () => {
    render(<InTable />);
    fireEvent.click(combobox());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(combobox());
    fireEvent.keyDown(combobox(), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(combobox());
  });

  it("holds the page still while open", () => {
    render(<InTable />);
    fireEvent.click(combobox());
    const e = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    screen.getByTestId("table").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});
