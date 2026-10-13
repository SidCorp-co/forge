"use client";

import { type HTMLAttributes, type ReactNode, useState } from "react";
import { cn } from "@/lib/utils/cn";
import { Icon } from "../icons/icon";
import { TBody, TD, TH, THead, TR, Table } from "../primitives/table";
import {
  type DataTableModelColumn,
  type DataTableSort,
  type SortDirection,
  useDataTableRows,
} from "./data-table-model";

export interface DataTableColumn<Row> extends DataTableModelColumn<Row> {
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  align?: "start" | "end";
  headerClassName?: string;
  cellClassName?: string;
  /** Names a column whose header draws nothing (an actions column). */
  headerLabel?: string;
  /** The direction the first activation sorts in. The first of `sortDirections` unless named. */
  firstSort?: SortDirection;
}

export interface DataTableProps<Row> {
  rows: readonly Row[];
  columns: readonly DataTableColumn<Row>[];
  getRowId: (row: Row) => string;
  /** Controlled sort. Leave it out and the table keeps its own, starting from `defaultSort`. */
  sort?: DataTableSort | null;
  defaultSort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort) => void;
  search?: string;
  filters?: Readonly<Record<string, string>>;
  /** The rows arrive in the order `sort` names, as a server ranking does: the headers report the sort and the table does not reorder. */
  manualSort?: boolean;
  /** The rows arrive already filtered, as when a screen cuts them into groups before they reach the table. */
  manualFilter?: boolean;
  /** Shown in place of the rows when none remain. */
  empty?: ReactNode;
  rowProps?: (row: Row) => HTMLAttributes<HTMLTableRowElement>;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

const ARIA_SORT = { asc: "ascending", desc: "descending" } as const;

function directionsOf<Row>(column: DataTableColumn<Row>): readonly SortDirection[] {
  return column.sortDirections ?? ["asc", "desc"];
}

function nextSort<Row>(column: DataTableColumn<Row>, current: DataTableSort | null): DataTableSort {
  const directions = directionsOf(column);
  const first = column.firstSort ?? directions[0] ?? "asc";
  if (current?.id !== column.id) return { id: column.id, desc: first === "desc" };
  const other: SortDirection = current.desc ? "asc" : "desc";
  return directions.includes(other) ? { id: column.id, desc: other === "desc" } : current;
}

// The header cell gives up its padding to the button, so the whole cell is what a press lands on.
const DENSITY_PY = { paddingTop: "var(--density-row-py)", paddingBottom: "var(--density-row-py)" };

function SortHeader<Row>({
  column,
  active,
  onActivate,
}: {
  column: DataTableColumn<Row>;
  active: DataTableSort | null;
  onActivate: () => void;
}) {
  const sorted = active?.id === column.id ? active : null;
  return (
    <button
      type="button"
      onClick={onActivate}
      style={DENSITY_PY}
      className={cn(
        "flex min-h-6 w-full cursor-pointer items-center gap-1 px-4 [font:inherit] [letter-spacing:inherit] [text-transform:inherit] hover:text-fg focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]",
        column.align === "end" && "justify-end",
      )}
    >
      {column.header}
      <Icon
        name={sorted ? "chevronDown" : "chevronUpDown"}
        size={12}
        className={cn("flex-none", sorted ? "text-fg" : "text-disabled", sorted && !sorted.desc && "rotate-180")}
      />
    </button>
  );
}

/**
 * A table whose headers sort it and whose rows can be searched and filtered, drawn with the same
 * Table primitives as any other. The ordering itself is `useDataTableRows`'s, so a screen that also
 * shows these rows another way asks the same engine and cannot disagree.
 */
export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  sort,
  defaultSort = null,
  onSortChange,
  search,
  filters,
  manualSort,
  manualFilter,
  empty,
  rowProps,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: DataTableProps<Row>) {
  const [ownSort, setOwnSort] = useState<DataTableSort | null>(defaultSort);
  const active = sort === undefined ? ownSort : sort;
  const shown = useDataTableRows(rows, columns, { sort: active, search, filters, manualSort, manualFilter });

  function activate(column: DataTableColumn<Row>) {
    const next = nextSort(column, active);
    if (sort === undefined) setOwnSort(next);
    onSortChange?.(next);
  }

  return (
    <Table className={className} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}>
      <THead>
        <TR className="hover:bg-transparent">
          {columns.map((column) => {
            const sorted = active?.id === column.id ? active : null;
            return (
              <TH
                key={column.id}
                scope="col"
                aria-sort={column.sortValue ? (sorted ? ARIA_SORT[sorted.desc ? "desc" : "asc"] : "none") : undefined}
                aria-label={column.sortValue ? undefined : column.headerLabel}
                className={cn(column.align === "end" && "text-right", column.headerClassName)}
                style={column.sortValue ? { padding: 0 } : undefined}
              >
                {column.sortValue ? (
                  <SortHeader column={column} active={active} onActivate={() => activate(column)} />
                ) : (
                  column.header
                )}
              </TH>
            );
          })}
        </TR>
      </THead>
      <TBody>
        {shown.length === 0 && empty !== undefined ? (
          <TR className="hover:bg-transparent">
            <TD colSpan={columns.length}>{empty}</TD>
          </TR>
        ) : (
          shown.map((row) => {
            const { className: rowClass, ...props } = rowProps?.(row) ?? {};
            return (
              <TR key={getRowId(row)} className={rowClass} {...props}>
                {columns.map((column) => (
                  <TD key={column.id} className={cn(column.align === "end" && "text-right", column.cellClassName)}>
                    {column.cell(row)}
                  </TD>
                ))}
              </TR>
            );
          })
        )}
      </TBody>
    </Table>
  );
}
