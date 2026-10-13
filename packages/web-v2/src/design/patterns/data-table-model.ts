"use client";

// The one file that imports @tanstack/react-table. A feature describes its columns in the types
// below and never sees the library, so a new major of it is a change to this file alone.

import {
  type ColumnDef,
  columnFilteringFeature,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useMemo } from "react";

type Key = string | number;
export type SortKey = Key | null | undefined;
/** What a column orders by. An array is compared element by element, so a tie on the first key falls to the second. */
export type SortValue = SortKey | readonly Key[];
export type SortDirection = "asc" | "desc";

export interface DataTableSort {
  id: string;
  desc: boolean;
}

/** What the engine reads of a column. A view that is not a table passes these alone. */
export interface DataTableModelColumn<Row> {
  /** Unique within one table. Sort and filter state name a column by it. */
  id: string;
  /** Makes the column sortable. Null and undefined sort last in either direction. */
  sortValue?: (row: Row) => SortValue;
  /** The directions the column can be ordered in, for one whose order only exists one way. Both unless named. */
  sortDirections?: readonly SortDirection[];
  /** Makes the column part of the search. */
  searchText?: (row: Row) => string | null | undefined;
  /** Makes the column filterable: a row stays when this equals the value chosen for the column. */
  filterValue?: (row: Row) => string;
}

export interface DataTableModelOptions {
  sort?: DataTableSort | null;
  /** Case-insensitive; matches a row when any column's `searchText` contains it. Blank keeps every row. */
  search?: string;
  /** Column id to the value chosen for it. A blank value keeps every row. */
  filters?: Readonly<Record<string, string>>;
  /** The caller ordered the rows, so the engine leaves them as given. */
  manualSort?: boolean;
  /** The caller cut the rows by search and filters before they got here. */
  manualFilter?: boolean;
}

interface Item<Row> {
  row: Row;
}

const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
});

const collator = new Intl.Collator();
const NO_FILTERS: Readonly<Record<string, string>> = {};

function compareKeys(a: string | number, b: string | number, columnId: string): number {
  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "string" && typeof b === "string") return collator.compare(a, b);
  throw new Error(
    `DataTable column "${columnId}" sorts a ${typeof a} against a ${typeof b}: one column orders by one kind of key, so make its sortValue return only numbers or only strings.`,
  );
}

function compareValues(a: SortValue, b: SortValue, columnId: string): number {
  const left = Array.isArray(a) ? (a as readonly Key[]) : [a as Key];
  const right = Array.isArray(b) ? (b as readonly Key[]) : [b as Key];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i];
    const y = right[i];
    if (x == null || y == null) {
      throw new Error(
        `DataTable column "${columnId}" has a null or undefined key inside an array sortValue: return null for the whole value to sort the row last, or give every row a key.`,
      );
    }
    const by = compareKeys(x, y, columnId);
    if (by !== 0) return by;
  }
  return left.length - right.length;
}

function assertColumns<Row>(columns: readonly DataTableModelColumn<Row>[], options: DataTableModelOptions): void {
  const ids = new Set<string>();
  for (const column of columns) {
    if (ids.has(column.id)) {
      throw new Error(`DataTable has two columns with the id "${column.id}": an id names one column, so give each its own.`);
    }
    ids.add(column.id);
  }
  const sort = options.sort;
  if (sort) {
    const column = columns.find((c) => c.id === sort.id && c.sortValue);
    if (!column) {
      const sortable = columns.filter((c) => c.sortValue).map((c) => c.id);
      throw new Error(
        `DataTable was asked to sort by "${sort.id}", which is not a sortable column: the columns that declare a sortValue are ${sortable.length ? sortable.join(", ") : "none"}.`,
      );
    }
    const direction: SortDirection = sort.desc ? "desc" : "asc";
    if (column.sortDirections && !column.sortDirections.includes(direction)) {
      throw new Error(
        `DataTable was asked to sort "${sort.id}" ${direction}ending, which that column does not support: it declares ${column.sortDirections.join(", ")} only.`,
      );
    }
  }
  for (const [id, value] of Object.entries(options.filters ?? NO_FILTERS)) {
    if (value !== "" && !columns.some((c) => c.id === id && c.filterValue)) {
      throw new Error(`DataTable was asked to filter "${id}", which is not a filterable column: declare a filterValue on it.`);
    }
  }
  if ((options.search ?? "").trim() !== "" && !columns.some((c) => c.searchText)) {
    throw new Error("DataTable was given a search but no column declares a searchText, so it would match nothing.");
  }
}

/**
 * The rows a table would show: filtered by the search and the column filters, then ordered by the
 * sort. DataTable renders through this, and a view that is not a table (cards) calls it directly so
 * both show the same order from one engine.
 */
export function useDataTableRows<Row>(
  rows: readonly Row[],
  columns: readonly DataTableModelColumn<Row>[],
  options: DataTableModelOptions = {},
): readonly Row[] {
  const { sort = null, search = "", filters = NO_FILTERS, manualSort = false, manualFilter = false } = options;
  assertColumns(columns, { sort, search, filters });

  const items = useMemo(() => rows.map((row) => ({ row })), [rows]);
  const definitions = useMemo<ColumnDef<typeof features, Item<Row>>[]>(
    () =>
      columns.map((c) => ({
        id: c.id,
        accessorFn: (item) => {
          const value = c.sortValue?.(item.row);
          return value === null ? undefined : value;
        },
        enableSorting: Boolean(c.sortValue),
        sortFn: (a, b) => compareValues(a.getValue(c.id) as SortValue, b.getValue(c.id) as SortValue, c.id),
        sortUndefined: "last",
        enableColumnFilter: Boolean(c.filterValue),
        filterFn: (item, _id, chosen: string) => c.filterValue?.(item.original.row) === chosen,
        enableGlobalFilter: Boolean(c.searchText),
      })),
    [columns],
  );
  const searchers = useMemo(() => new Map(columns.flatMap((c) => (c.searchText ? [[c.id, c.searchText] as const] : []))), [columns]);

  const needle = search.trim().toLowerCase();
  const columnFilters = useMemo(
    () => Object.entries(filters).filter(([, value]) => value !== "").map(([id, value]) => ({ id, value })),
    [filters],
  );
  const sorting = useMemo(() => (sort ? [{ id: sort.id, desc: sort.desc }] : []), [sort]);

  const table = useTable({
    features,
    columns: definitions,
    data: items,
    state: { sorting, columnFilters, globalFilter: needle === "" ? undefined : needle },
    manualSorting: manualSort,
    manualFiltering: manualFilter,
    getColumnCanGlobalFilter: (column) => searchers.has(column.id),
    globalFilterFn: (row, columnId, chosen: string) =>
      (searchers.get(columnId)?.((row.original as Item<Row>).row) ?? "").toLowerCase().includes(chosen),
  });

  const ordered = table.getRowModel().rows;
  return useMemo(() => ordered.map((r) => (r.original as Item<Row>).row), [ordered]);
}
