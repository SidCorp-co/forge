// @vitest-environment jsdom
//
// ISS-1263: what a person using a sortable table can rely on: the header says which way the table is
// ordered, activating it orders the rows, a column with one direction never offers the other, and a
// table whose rows arrive ordered (a server ranking) reports the request without reordering.

import * as matchers from "@testing-library/jest-dom/matchers";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./data-table";

expect.extend(matchers);
afterEach(cleanup);

interface Row {
  id: string;
  name: string;
  runs: number;
}

const ROWS: Row[] = [
  { id: "1", name: "bravo", runs: 5 },
  { id: "2", name: "alpha", runs: 20 },
  { id: "3", name: "charlie", runs: 1 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", cell: (r) => r.name, sortValue: (r) => r.name, searchText: (r) => r.name },
  { id: "runs", header: "Runs", cell: (r) => r.runs, sortValue: (r) => r.runs, align: "end", firstSort: "desc" },
  { id: "actions", header: null, headerLabel: "Actions", cell: () => "·" },
];

const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((tr) => within(tr).getAllByRole("cell")[0]?.textContent);
const header = (name: string) => screen.getByRole("columnheader", { name: new RegExp(name) });

function Sample(props: Partial<Parameters<typeof DataTable<Row>>[0]>) {
  return <DataTable rows={ROWS} columns={COLUMNS} getRowId={(r) => r.id} aria-label="Things" {...props} />;
}

describe("DataTable: headers", () => {
  it("says a sortable column is unsorted until it is, and a plain column says nothing", () => {
    render(<Sample />);
    expect(header("Name")).toHaveAttribute("aria-sort", "none");
    expect(screen.getByRole("columnheader", { name: "Actions" })).not.toHaveAttribute("aria-sort");
  });

  it("puts aria-sort on the header cell and none on the button inside it", () => {
    render(<Sample defaultSort={{ id: "name", desc: false }} />);
    expect(header("Name")).toHaveAttribute("aria-sort", "ascending");
    expect(within(header("Name")).getByRole("button")).not.toHaveAttribute("aria-sort");
  });

  it("gives a header that draws nothing the name it was declared with", () => {
    render(<Sample />);
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });
});

describe("DataTable: sorting by header", () => {
  it("orders by the column on first activation and reverses it on the second", () => {
    render(<Sample />);
    fireEvent.click(within(header("Name")).getByRole("button"));
    expect(names()).toEqual(["alpha", "bravo", "charlie"]);
    expect(header("Name")).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(within(header("Name")).getByRole("button"));
    expect(names()).toEqual(["charlie", "bravo", "alpha"]);
    expect(header("Name")).toHaveAttribute("aria-sort", "descending");
  });

  it("starts a column in the direction it declares", () => {
    render(<Sample />);
    fireEvent.click(within(header("Runs")).getByRole("button"));
    expect(header("Runs")).toHaveAttribute("aria-sort", "descending");
    expect(names()).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("moves the mark to the column last activated", () => {
    render(<Sample defaultSort={{ id: "name", desc: false }} />);
    fireEvent.click(within(header("Runs")).getByRole("button"));
    expect(header("Name")).toHaveAttribute("aria-sort", "none");
    expect(header("Runs")).toHaveAttribute("aria-sort", "descending");
  });

  it("is reachable and operable from the keyboard because the header holds a native button", () => {
    render(<Sample />);
    const button = within(header("Name")).getByRole("button");
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
  });

  it("makes the whole header cell the press target: no padding on the cell, the button fills it and is at least 24px tall", () => {
    render(<Sample />);
    for (const name of ["Name", "Runs"]) {
      const th = header(name);
      expect(th.style.padding, `${name} cell`).toBe("0px");
      const button = within(th).getByRole("button");
      expect(button.className, `${name} button`).toMatch(/\bw-full\b/);
      expect(button.className, `${name} button`).toMatch(/\bmin-h-6\b/);
      expect(button.style.paddingTop, `${name} button`).toBe("var(--density-row-py)");
    }
    expect(within(header("Runs")).getByRole("button").className).toMatch(/justify-end/);
  });

  it("starts from defaultSort", () => {
    render(<Sample defaultSort={{ id: "runs", desc: true }} />);
    expect(names()).toEqual(["alpha", "bravo", "charlie"]);
  });
});

describe("DataTable: a controlled sort", () => {
  it("reports the request and leaves the mark to the caller", () => {
    const onSortChange = vi.fn();
    render(<Sample sort={{ id: "name", desc: false }} onSortChange={onSortChange} />);
    fireEvent.click(within(header("Name")).getByRole("button"));
    expect(onSortChange).toHaveBeenCalledWith({ id: "name", desc: true });
    expect(header("Name")).toHaveAttribute("aria-sort", "ascending");
  });
});

describe("DataTable: a ranking that exists one way", () => {
  const onlyDesc: DataTableColumn<Row>[] = [
    { id: "name", header: "Name", cell: (r) => r.name },
    { id: "runs", header: "Runs", cell: (r) => r.runs, sortValue: (r) => r.runs, sortDirections: ["desc"] },
  ];

  it("never asks for the direction it lacks, on the first activation or the second", () => {
    const onSortChange = vi.fn();
    render(<Sample columns={onlyDesc} sort={{ id: "runs", desc: true }} onSortChange={onSortChange} manualSort />);
    fireEvent.click(within(header("Runs")).getByRole("button"));
    expect(onSortChange).toHaveBeenLastCalledWith({ id: "runs", desc: true });
  });

  it("starts a column that only has descending in descending", () => {
    const onSortChange = vi.fn();
    render(<Sample columns={onlyDesc} sort={null} onSortChange={onSortChange} manualSort />);
    fireEvent.click(within(header("Runs")).getByRole("button"));
    expect(onSortChange).toHaveBeenCalledWith({ id: "runs", desc: true });
  });
});

describe("DataTable: rows that arrive ordered", () => {
  it("shows them as given and still marks the sort the caller names", () => {
    render(<Sample sort={{ id: "name", desc: false }} manualSort />);
    expect(names()).toEqual(["bravo", "alpha", "charlie"]);
    expect(header("Name")).toHaveAttribute("aria-sort", "ascending");
  });
});

describe("DataTable: search and the empty row", () => {
  it("keeps the rows the search matches", () => {
    render(<Sample search="ALP" />);
    expect(names()).toEqual(["alpha"]);
  });

  it("shows what it was given in place of rows when none remain, under the headers", () => {
    render(<Sample search="zzz" empty="Nothing matches" />);
    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Name/ })).toBeInTheDocument();
  });

  it("shows an empty body when none remain and nothing was given to say so", () => {
    render(<Sample search="zzz" />);
    expect(screen.queryByRole("cell")).toBeNull();
  });
});

describe("DataTable: rows and the table itself", () => {
  it("passes each row its own props and keeps the table's label", () => {
    const onClick = vi.fn();
    render(<Sample rowProps={(r) => ({ onClick: () => onClick(r.id), className: "cursor-pointer" })} />);
    fireEvent.click(screen.getByText("alpha"));
    expect(onClick).toHaveBeenCalledWith("2");
    expect(screen.getByRole("table", { name: "Things" })).toBeInTheDocument();
  });
});
