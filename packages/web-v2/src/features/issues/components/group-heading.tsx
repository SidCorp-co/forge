"use client";

import { Button, SectionTitle } from "@/design";
import type { IssueGroup } from "../derive";
import type { GroupBy, ModuleCounts, ModuleRollupResponse } from "../types";

/** What the module rollup says about one group's module, or why it says nothing. */
export type ModuleGroupCounts =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "read"; primary: ModuleCounts; secondaryTotal: number };

interface RollupRead {
  isLoading: boolean;
  isError: boolean;
  data: ModuleRollupResponse | undefined;
}

/** The counts for a module group's header. A group is the issues whose primary module this is, which
 *  is `own.primary` of its rollup row exactly; the issues with no module are `unassigned`. A read
 *  that failed, or a module the rollup does not hold, is `unavailable` and said so, never a zero. */
export function moduleGroupCounts(group: IssueGroup, rollup: RollupRead): ModuleGroupCounts {
  if (rollup.isLoading) return { state: "loading" };
  if (rollup.isError || !rollup.data) return { state: "unavailable" };
  if (group.moduleId === null || group.moduleId === undefined) {
    return { state: "read", primary: rollup.data.unassigned, secondaryTotal: 0 };
  }
  const row = rollup.data.modules.find((m) => m.id === group.moduleId);
  if (!row) return { state: "unavailable" };
  return { state: "read", primary: row.own.primary, secondaryTotal: row.own.secondary.total };
}

interface GroupHeadingProps {
  group: IssueGroup;
  groupBy: GroupBy;
  /** Only read under `groupBy: "module"`. */
  counts?: ModuleGroupCounts;
  /** Narrow the list to this group's module, replacing the grouping. */
  onlyThisModule?: (moduleId: string) => void;
}

export function GroupHeading({ group, groupBy, counts, onlyThisModule }: GroupHeadingProps) {
  if (groupBy !== "module") {
    return (
      <SectionTitle className="fg-overline mb-2 px-1 font-mono">
        {group.label} · {group.rows.length}
      </SectionTitle>
    );
  }
  return (
    <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-1">
      <SectionTitle className="fg-overline font-mono">
        {group.label} · {group.rows.length} on this page
      </SectionTitle>
      <span className="fg-caption text-muted" data-testid="module-group-counts">
        {counts === undefined || counts.state === "loading"
          ? "Counting the project…"
          : counts.state === "unavailable"
            ? "Project counts unavailable"
            : `${counts.primary.total} in the project · ${counts.primary.open} open${
                counts.secondaryTotal > 0 ? ` · also tagged on ${counts.secondaryTotal}` : ""
              }`}
      </span>
      {group.moduleId && onlyThisModule ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onlyThisModule(group.moduleId as string)}
          aria-label={`Show only ${group.label}`}
        >
          Only this module
        </Button>
      ) : null}
    </div>
  );
}
