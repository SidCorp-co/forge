"use client";

import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  type DataTableColumn,
  EmptyState,
  Skeleton,
} from "@/design";
import { formatCount, formatMinutes, formatUsd } from "../format";
import type { AdminWorkspaceRow, OperatorWorkspaceSort } from "../types";

const SORTS: readonly OperatorWorkspaceSort[] = ["runs", "spend", "leadTime"];
const ROW_LIMIT = 10;

// The server ranks the workspaces, largest first, and has no ascending ranking to offer.
const RANKED = { sortDirections: ["desc"], firstSort: "desc", align: "end" } as const;

const COLUMNS: DataTableColumn<AdminWorkspaceRow>[] = [
  { id: "workspace", header: "Workspace", cellClassName: "font-mono", cell: (r) => r.slug },
  {
    id: "runs",
    header: "Runs",
    ...RANKED,
    cellClassName: "font-mono tabular-nums",
    sortValue: (r) => r.runs,
    cell: (r) => formatCount(r.runs),
  },
  {
    id: "spend",
    header: "Spend",
    ...RANKED,
    cellClassName: "font-mono tabular-nums",
    sortValue: (r) => r.spendUsd,
    cell: (r) => formatUsd(r.spendUsd),
  },
  {
    id: "leadTime",
    header: "Median lead",
    ...RANKED,
    cellClassName: "font-mono tabular-nums",
    sortValue: (r) => r.medianLeadTimeMin,
    cell: (r) => formatMinutes(r.medianLeadTimeMin),
  },
  {
    id: "open",
    header: "Open",
    align: "end",
    cellClassName: "font-mono tabular-nums",
    cell: (r) => formatCount(r.openIssues),
  },
];

function toWorkspaceSort(id: string): OperatorWorkspaceSort {
  const sort = SORTS.find((s) => s === id);
  if (!sort) throw new Error(`The workspaces table cannot rank by "${id}": the server ranks by ${SORTS.join(", ")}.`);
  return sort;
}

export function WorkspacesTableSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top workspaces</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} variant="text" className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}

export function WorkspacesTable({
  rows,
  sort,
  onSortChange,
}: {
  rows: readonly AdminWorkspaceRow[];
  sort: OperatorWorkspaceSort;
  onSortChange: (sort: OperatorWorkspaceSort) => void;
}) {
  const shown = useMemo(() => rows.slice(0, ROW_LIMIT), [rows]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top workspaces</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            title="No workspace activity"
            message="No project has run anything in this window. Widen the window to see more."
            mascot={false}
          />
        ) : (
          <DataTable
            aria-label="Top workspaces"
            className="min-w-[520px]"
            rows={shown}
            columns={COLUMNS}
            getRowId={(r) => r.projectId}
            sort={{ id: sort, desc: true }}
            onSortChange={(s) => onSortChange(toWorkspaceSort(s.id))}
            manualSort
          />
        )}
      </CardContent>
    </Card>
  );
}
