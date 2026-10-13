// @vitest-environment jsdom
//
// ISS-1263: sorting and filtering for every list screen come from one engine. These pin the rules a
// screen relies on without naming the library behind it: how keys compare, where missing keys go,
// what a search and a filter keep, what a manual table leaves alone, and which misuse is refused.

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type DataTableModelColumn, type DataTableModelOptions, useDataTableRows } from "./data-table-model";

interface Item {
  id: string;
  name: string;
  count: number | null;
  rank: number;
  tag: string;
  note?: string | null;
}

const ITEMS: Item[] = [
  { id: "a", name: "Bravo", count: 10, rank: 2, tag: "x", note: "Fast Lane" },
  { id: "b", name: "alpha", count: 9, rank: 1, tag: "y", note: null },
  { id: "c", name: "charlie", count: null, rank: 2, tag: "x", note: "slow lane" },
  { id: "d", name: "Delta", count: 9, rank: 1, tag: "y" },
];

const COLUMNS: DataTableModelColumn<Item>[] = [
  { id: "name", sortValue: (r) => r.name, searchText: (r) => r.name },
  { id: "count", sortValue: (r) => r.count },
  { id: "rank", sortValue: (r) => [r.rank, r.name] },
  { id: "note", searchText: (r) => r.note },
  { id: "tag", filterValue: (r) => r.tag },
  { id: "inert" },
];

function ids(options: DataTableModelOptions, columns = COLUMNS, rows = ITEMS) {
  const { result } = renderHook(() => useDataTableRows(rows, columns, options));
  return result.current.map((r) => r.id);
}

describe("useDataTableRows: how a column orders", () => {
  it("keeps the input order when no sort is asked for", () => {
    expect(ids({})).toEqual(["a", "b", "c", "d"]);
  });

  it("orders strings by locale, not by code point, so alpha precedes Bravo", () => {
    expect(ids({ sort: { id: "name", desc: false } })).toEqual(["b", "a", "c", "d"]);
  });

  it("orders numbers by value, so 9 precedes 10", () => {
    expect(ids({ sort: { id: "count", desc: false } })).toEqual(["b", "d", "a", "c"]);
  });

  it("orders an array of keys element by element, so a tie on the first falls to the second", () => {
    expect(ids({ sort: { id: "rank", desc: false } })).toEqual(["b", "d", "a", "c"]);
    expect(ids({ sort: { id: "rank", desc: true } })).toEqual(["c", "a", "d", "b"]);
  });

  it("puts a null key last whichever way the column is ordered", () => {
    expect(ids({ sort: { id: "count", desc: false } }).at(-1)).toBe("c");
    expect(ids({ sort: { id: "count", desc: true } }).at(-1)).toBe("c");
  });

  it("keeps the input order between equal keys, ascending and descending", () => {
    expect(ids({ sort: { id: "count", desc: false } }).slice(0, 2)).toEqual(["b", "d"]);
    expect(ids({ sort: { id: "count", desc: true } }).slice(1, 3)).toEqual(["b", "d"]);
  });

  it("reverses exactly the non-null order when descending", () => {
    const asc = ids({ sort: { id: "name", desc: false } });
    expect(ids({ sort: { id: "name", desc: true } })).toEqual([...asc].reverse());
  });
});

describe("useDataTableRows: search and filters", () => {
  it("matches a search case-insensitively against the columns that declare searchText", () => {
    expect(ids({ search: "ALPHA" })).toEqual(["b"]);
    expect(ids({ search: "lane" })).toEqual(["a", "c"]);
  });

  it("does not search a column that declares no searchText", () => {
    expect(ids({ search: "x" })).toEqual([]);
  });

  it("trims a search and treats a blank one as no search", () => {
    expect(ids({ search: "  delta " })).toEqual(["d"]);
    expect(ids({ search: "   " })).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps only the rows whose value equals the one chosen for the column", () => {
    expect(ids({ filters: { tag: "x" } })).toEqual(["a", "c"]);
  });

  it("keeps every row for a blank filter value", () => {
    expect(ids({ filters: { tag: "" } })).toEqual(["a", "b", "c", "d"]);
  });

  it("applies search, filter and sort together, filtering first", () => {
    expect(ids({ search: "a", filters: { tag: "x" }, sort: { id: "name", desc: true } })).toEqual(["c", "a"]);
  });
});

describe("useDataTableRows: a manual table", () => {
  it("leaves the order as given under manualSort", () => {
    expect(ids({ sort: { id: "name", desc: false }, manualSort: true })).toEqual(["a", "b", "c", "d"]);
  });

  it("leaves the rows as given under manualFilter", () => {
    expect(ids({ search: "alpha", filters: { tag: "x" }, manualFilter: true })).toEqual(["a", "b", "c", "d"]);
  });
});

describe("useDataTableRows: refuses what cannot be answered", () => {
  it("names the column it was asked to sort that does not sort", () => {
    expect(() => ids({ sort: { id: "inert", desc: false } })).toThrow(/"inert".*not a sortable column.*name, count, rank/);
  });

  it("names a sort for a column that does not exist", () => {
    expect(() => ids({ sort: { id: "nope", desc: false } })).toThrow(/"nope".*not a sortable column/);
  });

  it("names a direction the column does not support", () => {
    const columns: DataTableModelColumn<Item>[] = [{ id: "count", sortValue: (r) => r.count, sortDirections: ["desc"] }];
    expect(() => ids({ sort: { id: "count", desc: false } }, columns)).toThrow(/"count" ascending.*desc only/);
    expect(ids({ sort: { id: "count", desc: true } }, columns)).toEqual(["a", "b", "d", "c"]);
  });

  it("names a filter for a column that declares no filterValue", () => {
    expect(() => ids({ filters: { name: "x" } })).toThrow(/"name".*not a filterable column/);
  });

  it("refuses a search no column can answer rather than showing an empty list", () => {
    const columns: DataTableModelColumn<Item>[] = [{ id: "name", sortValue: (r) => r.name }];
    expect(() => ids({ search: "a" }, columns)).toThrow(/no column declares a searchText/);
  });

  it("refuses two columns that share an id", () => {
    const columns: DataTableModelColumn<Item>[] = [{ id: "name" }, { id: "name" }];
    expect(() => ids({}, columns)).toThrow(/two columns with the id "name"/);
  });

  it("refuses a column that orders a number against a string", () => {
    const columns: DataTableModelColumn<Item>[] = [{ id: "mixed", sortValue: (r) => (r.id === "a" ? 1 : r.id) }];
    expect(() => ids({ sort: { id: "mixed", desc: false } }, columns)).toThrow(/"mixed" sorts a (number|string) against a (number|string)/);
  });
});
