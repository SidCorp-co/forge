"use client";

import {
  Checkbox,
  SortableTH,
  Table,
  TBody,
  TH,
  THead,
  TR,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@/design";
import { Fragment, useMemo } from "react";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { Copy } from "@/lib/i18n/product-copy";
import { groupRows } from "../../derive";
import { hasLiveAgentSession } from "../../waiting";
import type { GroupBy, IssueRow, IssueSort } from "../../types";
import { IssueTableRow, type RowAssignee } from "../issue-row-actions";
import type { RowActions } from "../issue-table-row";

const columnsOf = (t: Copy): ColumnDef<IssueRow, unknown>[] => [
  { id: "createdAt", header: t("issues.col.id"), enableSorting: true, sortDescFirst: true },
  { id: "title", header: t("issues.col.title"), enableSorting: false },
  { id: "status", header: t("issues.field.status"), enableSorting: false },
  { id: "priority", header: t("issues.field.priority"), enableSorting: true, sortDescFirst: true },
  { id: "assignee", header: t("issues.field.assignee"), enableSorting: false },
  { id: "updatedAt", header: t("issues.col.updated"), enableSorting: true, sortDescFirst: true },
];

/** The person an issue is assigned to, else the agent working it, named by the device its run is on. */
function assigneeOf(row: IssueRow, names: Map<string, RowAssignee>, t: Copy): RowAssignee | null {
  const person = row.assigneeId ? names.get(row.assigneeId) : undefined;
  if (person) return person;
  if (!hasLiveAgentSession(row.agentStatus)) return null;
  const live = row.agentSessions?.find((s) => hasLiveAgentSession(s.status));
  return { label: live?.deviceName ? t("issues.assignee.agentOn", { device: live.deviceName }) : t("issues.assignee.agent"), agent: true };
}

function sortToState(sort: IssueSort): SortingState {
  const [id, dir] = sort.split(":");
  return [{ id, desc: dir === "desc" }];
}

function stateToSort(state: SortingState): IssueSort {
  const first = state[0];
  if (!first) return "createdAt:desc";
  return `${first.id}:${first.desc ? "desc" : "asc"}` as IssueSort;
}

export interface TableSelection {
  selected: Set<string>;
  toggleRow: (id: string, next: boolean) => void;
  allOnPageSelected: boolean;
  someOnPageSelected: boolean;
  toggleAllOnPage: (next: boolean) => void;
}

/** One page of issues, grouped as header rows inside one flush table, sorted on the server. */
export function IssuesTable({
  rows,
  groupBy,
  sort,
  onSort,
  slug,
  actions,
  now,
  memberNames,
  selection,
}: {
  rows: IssueRow[];
  groupBy: GroupBy;
  sort: IssueSort;
  onSort: (next: IssueSort) => void;
  slug: string;
  actions: RowActions;
  now: number;
  memberNames: Map<string, RowAssignee>;
  /** Absent when the reader cannot act on rows in bulk. */
  selection?: TableSelection;
}) {
  const t = useCopy();
  const L = useLabel();
  const columns = useMemo(() => columnsOf(t), [t]);
  const sorting = useMemo(() => sortToState(sort), [sort]);
  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);
  const groupLabel = (g: { key: string; label: string }) =>
    groupBy === "status" ? L("issueStatus", g.key) : groupBy === "priority" ? L("issuePriority", g.key) : g.label;
  const sortTable = useReactTable<IssueRow>({
    columns,
    data: rows,
    manualSorting: true,
    enableSortingRemoval: true,
    getCoreRowModel: getCoreRowModel(),
    state: { sorting },
    onSortingChange: (updater) => {
      onSort(stateToSort(typeof updater === "function" ? updater(sorting) : updater));
    },
  });
  const headers = sortTable.getHeaderGroups()[0]?.headers ?? [];

  return (
    // One table runs edge to edge from the sidebar, scrolling sideways inside itself at phone width; a grouping is a header row in it, not a box per group (ISS-49)
    <Table aria-label={t("issues.screen.title")} className="min-w-[860px]">
      <THead>
        <TR>
          {selection && (
            <TH className="w-9 pr-0">
              <Checkbox
                checked={selection.allOnPageSelected}
                indeterminate={selection.someOnPageSelected}
                onChange={selection.toggleAllOnPage}
                ariaLabel={t("issues.table.selectAll")}
              />
            </TH>
          )}
          {headers.map((header) => (
            <SortableTH
              key={header.id}
              header={header}
              className={header.id === "createdAt" ? "w-px whitespace-nowrap" : undefined}
            />
          ))}
          <TH className="sr-only">{t("issues.table.actions")}</TH>
        </TR>
      </THead>
      <TBody>
        {groups.map((g) => (
          <Fragment key={g.key}>
            {groupBy !== "none" && (
              <TR className="bg-sunken hover:bg-sunken">
                <TH
                  scope="colgroup"
                  colSpan={headers.length + (selection ? 2 : 1)}
                  className="text-left"
                >
                  {groupLabel(g)} · {g.rows.length}
                </TH>
              </TR>
            )}
            {g.rows.map((row) => (
              <IssueTableRow
                key={row.id}
                row={row}
                slug={slug}
                actions={actions}
                now={now}
                assignee={assigneeOf(row, memberNames, t)}
                selection={
                  selection
                    ? {
                        selected: selection.selected.has(row.id),
                        onToggle: (next) => selection.toggleRow(row.id, next),
                      }
                    : undefined
                }
              />
            ))}
          </Fragment>
        ))}
      </TBody>
    </Table>
  );
}
