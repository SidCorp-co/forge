// Flush rows: a title is cut to one line unless the row asks it to wrap (a sentence the reader must
// read whole), and a row that opens something under it says whether it is open.

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RowItem, RowList } from "./row-list";

vi.mock("@/lib/navigation/router", async () => (await import("@/test/navigation")).navigationDouble());

function Opening() {
  const [open, setOpen] = useState(false);
  return (
    <RowList>
      <RowItem wrap expanded={open} onClick={() => setOpen((o) => !o)} title="A sentence the reader reads whole" testId="row">
        {open ? <p>detail</p> : null}
      </RowItem>
    </RowList>
  );
}

describe("RowItem", () => {
  it("cuts a title to one line by default, and lets it wrap where the row asks", () => {
    render(
      <RowList>
        <RowItem title="Cut" testId="cut" />
        <RowItem title="Whole" wrap testId="whole" />
      </RowList>,
    );
    expect(screen.getByText("Cut")).toHaveClass("truncate");
    expect(screen.getByText("Whole")).not.toHaveClass("truncate");
    expect(screen.getByText("Whole")).toHaveClass("break-words");
  });

  it("says on its button whether what it opens is open", () => {
    render(<Opening />);
    const button = screen.getByRole("button", { name: /A sentence/ });
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("detail")).toBeNull();
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("detail")).toBeTruthy();
  });
});
