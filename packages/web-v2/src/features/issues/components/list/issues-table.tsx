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
import { groupRows } from "../../derive";
import { hasLiveAgentSession } from "../../waiting";
import type { GroupBy, IssueRow, IssueSort } from "../../types";
import { IssueTableRow, type RowAssignee } from "../issue-row-actions";
import type { RowActions } from "../issue-table-row";

const ISSUE_COLUMNS: ColumnDef<IssueRow, unknown>[] = [
  { id: "createdAt", header: "ID", enableSorting: true, sortDescFirst: true },
  { id: "title", header: "Title", enableSorting: false },
  { id: "status", header: "Status", enableSorting: false },
  { id: "priority", header: "Priority", enableSorting: true, sortDescFirst: true },
  { id: "assignee", header: "Assignee", enableSorting: false },
  { id: "updatedAt", header: "Updated", enableSorting: true, sortDescFirst: true },
];

/** The person an issue is assigned to, else the agent working it, named by the device its run is on. */
function assigneeOf(row: IssueRow, names: Map<string, RowAssignee>): RowAssignee | null {
  const person = row.assigneeId ? names.get(row.assigneeId) : undefined;
  if (person) return person;
  if (!hasLiveAgentSession(row.agentStatus)) return null;
  const live = row.agentSessions?.find((s) => hasLiveAgentSession(s.status));
  return { label: live?.deviceName ? `Agent · ${live.deviceName}` : "Agent", agent: true };
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
  const sorting = useMemo(() => sortToState(sort), [sort]);
  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);
  const sortTable = useReactTable<IssueRow>({
    columns: ISSUE_COLUMNS,
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
    <Table aria-label="Issues" className="min-w-[860px]">
      <THead>
        <TR>
          {selection && (
            <TH className="w-9 pr-0">
              <Checkbox
                checked={selection.allOnPageSelected}
                indeterminate={selection.someOnPageSelected}
                onChange={selection.toggleAllOnPage}
                ariaLabel="Select all issues on this page"
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
          <TH className="sr-only">Actions</TH>
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
                  {g.label} · {g.rows.length}
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
                assignee={assigneeOf(row, memberNames)}
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
