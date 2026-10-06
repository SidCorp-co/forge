// The Select is base-ui's: the listbox portals to <body>, so a Select in a Table is not cut off by
// the table's clipping box (ISS-1172). These pin what the wrapper promises: the trigger names the
// chosen option or the placeholder, a disabled option cannot be chosen, and onChange receives the
// option's value.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Select, type SelectOption } from "./select";
import { Table, TBody, TD, TR } from "./table";

const OPTIONS: SelectOption[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "gone", label: "Oldest archived", disabled: true },
  { value: "priority", label: "Priority" },
];

function InTable({ onChange = vi.fn(), initial = "newest" }: { onChange?: (v: string) => void; initial?: string }) {
  const [value, setValue] = useState(initial);
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

describe("Select", () => {
  it("opens its listbox on <body>, outside the table box that clipped it", async () => {
    const user = userEvent.setup();
    render(<InTable />);
    await user.click(combobox());
    const listbox = await screen.findByRole("listbox");
    expect(screen.getByTestId("table").parentElement).not.toContainElement(listbox);
    expect(document.body).toContainElement(listbox);
  });

  it("names the chosen option on the trigger, and the placeholder for a value no option holds", () => {
    const { unmount } = render(<InTable />);
    expect(combobox()).toHaveTextContent("Newest");
    unmount();
    render(<InTable initial="nothing-like-it" />);
    expect(combobox()).toHaveTextContent("Select…");
  });

  it("marks the chosen option selected when it opens", async () => {
    const user = userEvent.setup();
    render(<InTable initial="oldest" />);
    await user.click(combobox());
    expect(await screen.findByRole("option", { name: "Oldest" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Newest" })).not.toHaveAttribute("aria-selected", "true");
  });

  it("selects the option clicked, hands its value to onChange and closes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<InTable onChange={onChange} />);
    await user.click(combobox());
    await user.click(await screen.findByRole("option", { name: "Priority" }));
    expect(onChange).toHaveBeenCalledWith("priority");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(combobox()).toHaveTextContent("Priority");
  });

  it("does not choose a disabled option", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<InTable onChange={onChange} />);
    await user.click(combobox());
    const gone = await screen.findByRole("option", { name: "Oldest archived" });
    expect(gone).toHaveAttribute("aria-disabled", "true");
    await user.click(gone);
    expect(onChange).not.toHaveBeenCalled();
    expect(combobox()).toHaveTextContent("Newest");
  });

  it("chooses with the keyboard: arrows move, Enter selects", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<InTable onChange={onChange} />);
    combobox().focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("listbox");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("option", { name: "Newest" })));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("option", { name: "Oldest" }));
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("oldest");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("closes on Escape and gives focus back to the trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<InTable onChange={onChange} />);
    combobox().focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(combobox());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not open while disabled", async () => {
    const user = userEvent.setup();
    render(<Select aria-label="Sort" options={OPTIONS} value="newest" disabled />);
    await user.click(screen.getByRole("combobox", { name: "Sort" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reads as invalid when it is told so", () => {
    render(<Select aria-label="Sort" options={OPTIONS} value="newest" invalid />);
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveAttribute("aria-invalid", "true");
  });
});
