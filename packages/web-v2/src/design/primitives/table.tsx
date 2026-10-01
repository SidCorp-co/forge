"use client";

import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type Header,
  type OnChangeFn,
  type SortingState,
} from "@tanstack/react-table";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Icon } from "@/design/icons/icon";
import { useScrollEdges } from "@/design/hooks/use-scroll-edges";
import { cn } from "@/lib/utils/cn";

export { flexRender, getCoreRowModel, getSortedRowModel, useReactTable };
export type { ColumnDef, Header, OnChangeFn, SortingState };

const DEFAULT_REGION_NAME = "Table, scrolls sideways";

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** No card frame: a top rule only, for a table that runs edge to edge of its page. */
  flush?: boolean;
}

export function Table({
  className,
  flush = false,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: TableProps) {
  const [scrollerRef, edges] = useScrollEdges<HTMLDivElement>();
  const overflows = edges.start || edges.end;
  const regionName = ariaLabelledBy
    ? { "aria-labelledby": ariaLabelledBy }
    : { "aria-label": ariaLabel ?? DEFAULT_REGION_NAME };
  return (
    <div className={cn("relative overflow-hidden bg-surface has-[>[role=region]:focus-visible]:outline-2 has-[>[role=region]:focus-visible]:outline-offset-2 has-[>[role=region]:focus-visible]:outline-cobalt", flush ? "border-t border-line" : "rounded-lg border border-line")}>
      <div
        ref={scrollerRef}
        className="relative overflow-x-auto [contain:inline-size] focus-visible:shadow-none"
        {...(overflows ? { role: "region", tabIndex: 0, ...regionName } : {})}
      >
        <table
          data-slot="table"
          className={cn("w-full border-collapse text-left", className)}
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          {...props}
        />
      </div>
      <EdgeCue side="start" visible={edges.start} />
      <EdgeCue side="end" visible={edges.end} />
    </div>
  );
}

function EdgeCue({ side, visible }: { side: "start" | "end"; visible: boolean }) {
  return (
    <span
      aria-hidden
      data-table-edge={side}
      data-visible={visible}
      className={cn(
        "pointer-events-none absolute inset-y-0 w-8 opacity-0 motion-safe:transition-opacity data-[visible=true]:opacity-100",
        side === "start"
          ? "left-0 bg-[linear-gradient(to_right,var(--scrim),transparent_10px),linear-gradient(to_right,var(--bg-surface),transparent)]"
          : "right-0 bg-[linear-gradient(to_left,var(--scrim),transparent_10px),linear-gradient(to_left,var(--bg-surface),transparent)]",
      )}
    />
  );
}

export function THead({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <TableHeader className={cn("border-b border-line [&_tr]:border-b-0 [&_tr]:hover:bg-transparent", className)} {...props} />;
}

export function TBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <TableBody className={className} {...props} />;
}

export function TR({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <TableRow
      className={cn("border-b border-line-subtle transition-colors last:border-0 hover:bg-hover", className)}
      {...props}
    />
  );
}

const DENSITY_PY = { paddingTop: "var(--density-row-py)", paddingBottom: "var(--density-row-py)" };

export function TH({ className, style, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <TableHead
      className={cn("fg-overline h-auto px-4 font-mono whitespace-normal text-subtle", className)}
      style={{ ...DENSITY_PY, ...style }}
      {...props}
    />
  );
}

export function TD({ className, style, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <TableCell
      className={cn("fg-body-sm px-4 text-fg whitespace-normal", className)}
      style={{ ...DENSITY_PY, ...style }}
      {...props}
    />
  );
}

export interface SortableTHProps<TData> extends ThHTMLAttributes<HTMLTableCellElement> {
  header: Header<TData, unknown>;
}

export function SortableTH<TData>({ header, className, children, ...props }: SortableTHProps<TData>) {
  const column = header.column;
  const label = children ?? flexRender(column.columnDef.header, header.getContext());
  if (!column.getCanSort()) {
    return (
      <TH className={className} {...props}>
        {label}
      </TH>
    );
  }
  const sorted = column.getIsSorted();
  return (
    <TH
      className={className}
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
      {...props}
    >
      <button
        type="button"
        onClick={column.getToggleSortingHandler()}
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-[inherit] hover:text-fg",
          sorted && "text-fg",
        )}
      >
        {label}
        <Icon
          name={sorted === "asc" ? "arrowUp" : sorted === "desc" ? "arrowDown" : "chevronUpDown"}
          size={12}
          className={sorted ? "text-accent" : "text-disabled"}
        />
      </button>
    </TH>
  );
}

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  manualSorting?: boolean;
  getRowId?: (row: TData) => string;
  "aria-label"?: string;
  className?: string;
}

export function DataTable<TData>({
  columns,
  data,
  sorting,
  onSortingChange,
  manualSorting = false,
  getRowId,
  className,
  "aria-label": ariaLabel,
}: DataTableProps<TData>) {
  const table = useReactTable({
    columns,
    data,
    getRowId,
    manualSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    ...(sorting ? { state: { sorting } } : {}),
    onSortingChange,
  });
  return (
    <Table className={className} aria-label={ariaLabel}>
      <THead>
        {table.getHeaderGroups().map((group) => (
          <TR key={group.id}>
            {group.headers.map((header) => (
              <SortableTH key={header.id} header={header} />
            ))}
          </TR>
        ))}
      </THead>
      <TBody>
        {table.getRowModel().rows.map((row) => (
          <TR key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TD key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TD>
            ))}
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
