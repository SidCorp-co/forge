// @vitest-environment jsdom
//
// ISS-1172: the listbox rendered inside the trigger's wrapper, so a Select in a
// Table was cut off by the table's clipping box; and the active option
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

  // ISS-1421 r36: on a phone two connections alike up to their minute were cut off before it.
  it("wraps a long option label rather than cutting off the end that tells it apart", () => {
    render(<InTable />);
    fireEvent.click(combobox());
    for (const label of document.querySelectorAll("[data-option-label]")) {
      expect(label.className).not.toMatch(/\btruncate\b/);
      expect(label.className).toContain("[overflow-wrap:anywhere]");
    }
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

  // ISS-1229 r37, judge-100: a disabled option's reason was the faintest text on screen, faded with its row,
  // when it is the answer to "why can't I pick this".
  it("fades a disabled option's label and never the reason under it", () => {
    render(
      <Select
        aria-label="Project"
        options={[{ value: "l", label: "Ledger", detail: "Its agent can't answer here.", disabled: true }]}
        value=""
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Project" }));
    const option = screen.getByRole("option", { name: /Ledger/ });
    const detail = option.querySelector("[data-option-detail]") as HTMLElement;
    for (let el: HTMLElement | null = detail; el && el !== option.parentElement; el = el.parentElement) {
      expect(el.className).not.toMatch(/opacity/);
    }
    expect(detail).toHaveClass("text-muted");
    expect(option.querySelector("[data-option-label]")).toHaveClass("text-subtle");
  });

  it("holds the page still while open", () => {
    render(<InTable />);
    fireEvent.click(combobox());
    const e = new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true });
    screen.getByTestId("table").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

// ISS-1421 r36, judge-145: the share picker listed connections of every provider in the order they
// were made. An option names its group, and the list shows each group under its heading.
describe("a list whose options name their group", () => {
  const GROUPED: SelectOption[] = [
    { value: "c1", label: "box-a.example", group: "Coolify" },
    { value: "c2", label: "box-b.example", group: "Coolify" },
    { value: "s1", label: "sentry.example", group: "Sentry" },
  ];

  it("shows each group under its heading, its options inside it, and keeps the keys moving across them", () => {
    const onChange = vi.fn();
    render(<Select aria-label="Connection" options={GROUPED} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Connection" }));
    const coolify = screen.getByRole("group", { name: "Coolify" });
    const sentry = screen.getByRole("group", { name: "Sentry" });
    expect(Array.from(coolify.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual([
      "box-a.example",
      "box-b.example",
    ]);
    expect(Array.from(sentry.querySelectorAll('[role="option"]')).map((o) => o.textContent)).toEqual([
      "sentry.example",
    ]);
    const combobox = screen.getByRole("combobox", { name: "Connection" });
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("s1");
  });

  it("shows no heading where no option names a group", () => {
    render(<Select aria-label="Sort" options={OPTIONS} value="newest" />);
    fireEvent.click(screen.getByRole("combobox", { name: "Sort" }));
    expect(screen.queryByRole("group")).toBeNull();
  });
});
