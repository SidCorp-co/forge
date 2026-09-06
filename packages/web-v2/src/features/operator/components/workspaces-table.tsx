"use client";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  SegmentedControl,
  Skeleton,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
} from "@/design";
import { formatCount, formatMinutes, formatUsd } from "../format";
import type { AdminWorkspaceRow, OperatorWorkspaceSort } from "../types";

const SORTS: { value: OperatorWorkspaceSort; label: string }[] = [
  { value: "runs", label: "Runs" },
  { value: "spend", label: "Spend" },
  { value: "leadTime", label: "Lead time" },
];

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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top workspaces</CardTitle>
        <SegmentedControl options={SORTS} value={sort} onChange={onSortChange} />
      </CardHeader>
      <CardContent className="px-0">
        {rows.length === 0 ? (
          <EmptyState
            title="No workspace activity"
            message="No project has run anything in this window. Widen the window to see more."
            mascot={false}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[520px]">
              <THead>
                <TR>
                  <TH scope="col">Workspace</TH>
                  <TH scope="col" className="text-right">Runs</TH>
                  <TH scope="col" className="text-right">Spend</TH>
                  <TH scope="col" className="text-right">Median lead</TH>
                  <TH scope="col" className="text-right">Open</TH>
                </TR>
              </THead>
              <TBody>
                {rows.slice(0, 10).map((r) => (
                  <TR key={r.projectId}>
                    <TD className="font-mono">{r.slug}</TD>
                    <TD className="text-right font-mono tabular-nums">{formatCount(r.runs)}</TD>
                    <TD className="text-right font-mono tabular-nums">{formatUsd(r.spendUsd)}</TD>
                    <TD className="text-right font-mono tabular-nums">{formatMinutes(r.medianLeadTimeMin)}</TD>
                    <TD className="text-right font-mono tabular-nums">{formatCount(r.openIssues)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
