// A table's column header reads as the shared grouped list's does: sentence case in the body face,
// never uppercase and never monospace (ISS-1072; owner's UI rules: flat, shared components).
// @direct-test-of packages/web-v2/src/design/primitives/table.tsx

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getCoreRowModel, SortableTH, Table, TBody, TD, TH, THead, TR, useReactTable } from "./table";

/** The classes that draw a header uppercase or in the code face. */
const SHOUTING = /(^|\s)(fg-overline|font-mono|uppercase|fg-mono|tracking-\[)/;

function Sorted() {
  const table = useReactTable({ data: [{ n: 1 }], columns: [{ accessorKey: "n", header: "Count" }], getCoreRowModel: getCoreRowModel() });
  return (
    <Table aria-label="t">
      <THead>
        <TR>
          {table.getHeaderGroups()[0]?.headers.map((h) => <SortableTH key={h.id} header={h} />)}
        </TR>
      </THead>
    </Table>
  );
}

describe("a table header", () => {
  it("is drawn in sentence case and the body face", () => {
    render(
      <Table aria-label="t">
        <THead>
          <TR>
            <TH>Channel</TH>
          </TR>
        </THead>
        <TBody>
          <TR>
            <TD>hop</TD>
          </TR>
        </TBody>
      </Table>,
    );
    expect(screen.getByRole("columnheader", { name: "Channel" }).className).not.toMatch(SHOUTING);
  });

  it("is so when it sorts, the button inside it too", () => {
    render(<Sorted />);
    const header = screen.getByRole("columnheader", { name: /Count/ });
    expect(header.className).not.toMatch(SHOUTING);
    expect(screen.getByRole("button", { name: /Count/ }).className).not.toMatch(SHOUTING);
  });
});
