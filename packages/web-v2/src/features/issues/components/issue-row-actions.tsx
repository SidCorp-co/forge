"use client";

// The Issues list's row: five columns on one grid, and the actions that hang off it (ISS-1155).

import {
  Avatar,
  Checkbox,
  Icon,
  IconButton,
  Menu,
  type MenuItem,
  MonoTag,
  Spinner,
  STATUS_META,
} from "@/design";
import { cn } from "@/lib/utils/cn";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  complexityLabel,
  creatorLabelOf,
  groupedTransitions,
  initials,
  priorityLabel,
  transitionLabels,
} from "../derive";
import { useStatusExits } from "../hooks";
import { AGENT_HOLDS_EDIT, heldByAgent } from "../edit-lock";
import type { ListDensity } from "../list-density";
import { stateReading } from "../state-reading";
import { ISSUE_COMPLEXITIES, ISSUE_PRIORITIES, type IssuePriority, type IssueRow } from "../types";
import { CELL, GRID, GridPart, gridStyle } from "./issue-grid";
import { DepBadges, ModuleCell, type RowActions, type RowSelection } from "./issue-row-parts";

/** ISS-700 — shared row-open behaviour: a pending flag set synchronously
 *  before navigation (so the row can dim + show a spinner) and a double-click
 *  guard (a second click during the pending window no-ops). The list stays
 *  mounted through client nav, so `pending` naturally clears on unmount —
 *  no reset needed. */
function useOpenIssue(slug: string, id: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const open = useCallback(() => {
    if (pending) return;
    setPending(true);
    router.push(`/projects/${slug}/issues/${id}`);
  }, [pending, router, slug, id]);
  return { open, pending };
}

/** The row's one state signal: a dot whose colour means something, the issue's own status word, what
 *  the run is doing about it, and how long. Everything it says comes from `stateReading`; the
 *  words stand beside the dot so the colour is never the only thing telling a state apart. */
export function StatusCell({ row, now = Date.now() }: { row: IssueRow; now?: number }) {
  const state = stateReading(row, now);
  const detail = state.runs.flatMap((r) => (r.detail ? [r.detail] : [])).join("\n") || undefined;
  const elapsed = state.elapsed;
  return (
    <div className="flex min-w-0 items-center gap-2" data-state-tone={state.tone}>
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full", state.live && "forge-pulse")}
        style={{ background: STATUS_META[state.tone].dot }}
      />
      <span className="text-13-5 shrink-0 whitespace-nowrap text-fg" data-testid="issue-state-word">
        {state.statusWord}
      </span>
      {state.runs.length > 0 && (
        <span className="fg-caption min-w-0 truncate" title={detail}>
          {state.runs.map((run, i) => (
            <span key={run.word}>
              {i > 0 && " · "}
              <span>{run.word}</span>
              {run.step && <span className="font-mono"> {run.step}</span>}
            </span>
          ))}
        </span>
      )}
      {state.waitingOnPerson ? (
        <span className="fg-caption flex min-w-0 whitespace-nowrap tabular-nums" data-testid="waiting-on-person" title={elapsed?.title}>
          <span className="truncate">Waiting on a person</span>
          {/* `whitespace-pre`: a flex item is blockified, and a block drops its leading space, so a bare " · " ran into the label. */}
          <span className="shrink-0 whitespace-pre"> · {state.waitingOnPerson.age}</span>
        </span>
      ) : (
        elapsed && (
          <span
            className={cn(
              "shrink-0 whitespace-nowrap tabular-nums",
              elapsed.stale ? "fg-caption fg-caption-stale inline-flex items-center gap-1" : "fg-caption",
            )}
            title={elapsed.title}
          >
            {elapsed.stale && <Icon name="clock" size={12} />}
            {elapsed.label}
          </span>
        )
      )}
    </div>
  );
}

const PRIORITY_CLASS: Record<IssuePriority, string> = {
  critical: "font-semibold text-[color:var(--red-600)]",
  high: "font-semibold text-[color:var(--amberw-600)]",
  medium: "text-fg",
  low: "text-muted",
  none: "text-subtle",
};

/** Priority as coloured text, not a pill: `none` is a dash. */
function PriorityCell({ priority }: { priority: IssuePriority }) {
  if (priority === "none") return <span className="text-13-5 text-subtle">—</span>;
  return <span className={cn("text-13-5 whitespace-nowrap", PRIORITY_CLASS[priority])}>{priorityLabel(priority)}</span>;
}

/**
 * Build the flat list of menu items for a row's overflow ⋯ action. The current
 * value of each field is skipped so every item is an actual change. Labels are
 * prefixed (`Status:` / `Priority:` / …) so the flat list still reads clearly.
 */
function useRowMenuItems(
  row: IssueRow,
  actions: RowActions,
  open: () => void,
): MenuItem[] {
  const { exits, isPending, isError } = useStatusExits();
  const items: MenuItem[] = [
    { label: "Open issue", icon: "arrowRight", onSelect: open },
  ];

  if (actions.canWrite === false) return items;

  if (heldByAgent(row.status, row.agentStatus)) {
    items.push({ label: AGENT_HOLDS_EDIT, disabled: true, separatorBefore: true });
    return items;
  }

  const grouped = groupedTransitions(exits, row.status);
  if (isPending) {
    items.push({ label: "Loading status moves…", disabled: true, separatorBefore: true });
  } else if (isError) {
    items.push({ label: "Couldn't load status moves", disabled: true, separatorBefore: true });
  }
  const statusNames = transitionLabels(grouped.map((g) => g.to));
  for (const [i, g] of grouped.entries()) {
    items.push({
      label: `Status: ${statusNames[i]}`,
      danger: g.kind === "discard",
      separatorBefore: g.startsGroup,
      onSelect: () => actions.transition({ id: row.id, toStatus: g.to }),
    });
  }
  for (const p of ISSUE_PRIORITIES) {
    if (p === row.priority) continue;
    items.push({
      label: `Priority: ${priorityLabel(p)}`,
      onSelect: () => actions.patch({ id: row.id, body: { priority: p } }),
    });
  }
  for (const c of ISSUE_COMPLEXITIES) {
    if (c === row.complexity) continue;
    items.push({
      label: `Complexity: ${complexityLabel(c)}`,
      onSelect: () => actions.patch({ id: row.id, body: { complexity: c } }),
    });
  }
  if (row.complexity) {
    items.push({
      label: "Complexity: clear",
      onSelect: () => actions.patch({ id: row.id, body: { complexity: null } }),
    });
  }
  return items;
}

/** Overflow row-action menu (⋯). Disabled while a mutation is in flight. */
function RowMenu({
  row,
  actions,
  open,
  side = "bottom",
}: {
  row: IssueRow;
  actions: RowActions;
  open: () => void;
  side?: "top" | "bottom";
}) {
  const items = useRowMenuItems(row, actions, open);
  return (
    <Menu
      align="right"
      side={side}
      items={items}
      trigger={
        <IconButton
          icon="more"
          size="sm"
          variant="ghost"
          className="max-lg:size-11"
          aria-label="Row actions"
          disabled={actions.isPending}
        />
      }
    />
  );
}

// One line, never two: a row that wraps its second line outgrows the 56px Comfortable bound on the
// narrowest desktop width. Module and creator give way (ellipsis), the kind and relations keep their size.
export const SUBTEXT = "hidden min-w-0 flex-nowrap items-center gap-x-3 overflow-hidden lg:flex";

export function IssueLine({
  row,
  slug,
  actions,
  selection,
  density,
  now,
}: {
  row: IssueRow;
  slug: string;
  actions: RowActions;
  /** Present for a reader who can select; absent for a viewer, whose select track is 0 wide. */
  selection?: RowSelection;
  density: ListDensity;
  /** One instant for the whole list, so the figures on two rows are a comparison and not two
   *  independent readings of the clock. */
  now: number;
}) {
  const { open, pending } = useOpenIssue(slug, row.id);
  const comfortable = density === "comfortable";
  const primaryModule = row.modules?.some((m) => m.isPrimary) ? row.modules : undefined;
  const label = creatorLabelOf(row);

  return (
    <GridPart
      role="row"
      aria-busy={pending}
      style={gridStyle(selection !== undefined)}
      className={cn(
        GRID,
        "group items-center border-b border-line-subtle py-1 transition-colors last:border-b-0 hover:bg-hover lg:py-0",
        comfortable ? "lg:py-1" : "lg:min-h-9",
        "[@media(pointer:coarse)]:min-h-11",
        pending && "opacity-60",
      )}
    >
      <GridPart role="cell" className={cn(CELL.select, "pl-3 max-lg:flex max-lg:h-11 max-lg:items-center")}>
        {selection && (
          <Checkbox
            checked={selection.selected}
            onChange={selection.onToggle}
            disabled={actions.isPending}
            ariaLabel={`Select ${row.displayId}`}
          />
        )}
      </GridPart>
      <GridPart role="cell" className={cn(CELL.id, "px-2")}>
        <span className="inline-flex items-center gap-1.5">
          <button
            type="button"
            onClick={open}
            aria-label={`Open ${row.displayId}`}
            className="inline-flex cursor-pointer items-center rounded-sm hover:opacity-80 focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)] max-lg:min-h-11"
          >
            <MonoTag hue="cobalt">{row.displayId}</MonoTag>
          </button>
          {pending && <Spinner size={14} />}
        </span>
      </GridPart>
      <GridPart role="cell" className={cn(CELL.title, "min-w-0 px-2")}>
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={open}
            aria-label={`Open ${row.displayId}: ${row.title}`}
            className="group/title min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
          >
            <span className="text-13-5 line-clamp-2 text-fg group-hover/title:text-accent-text group-hover/title:underline lg:truncate lg:line-clamp-none">
              {row.title}
            </span>
          </button>
          {/* The one relation a one-line row still owes its reader; Comfortable's second line carries it from lg up. */}
          <span className={cn("shrink-0", comfortable && "lg:hidden")}>
            <DepBadges deps={row.dependencies} slug={slug} show="blocking" />
          </span>
        </div>
        {comfortable && (
          <div className={SUBTEXT}>
            {primaryModule && (
              <span className="flex min-w-0 shrink">
                <ModuleCell modules={primaryModule} />
              </span>
            )}
            {row.category && (
              <span className="shrink-0 whitespace-nowrap">
                <MonoTag>{row.category}</MonoTag>
              </span>
            )}
            <span className="fg-caption min-w-0 flex-1 truncate">{label}</span>
            <span className="shrink-0">
              <DepBadges deps={row.dependencies} slug={slug} />
            </span>
          </div>
        )}
      </GridPart>
      <GridPart role="cell" className={cn(CELL.state, "min-w-0 px-2")}>
        <StatusCell row={row} now={now} />
      </GridPart>
      <GridPart role="cell" className={cn(CELL.priority, "px-2")}>
        <PriorityCell priority={row.priority} />
      </GridPart>
      <GridPart role="cell" className={cn(CELL.who, "px-1")}>
        <span role="img" aria-label={label} title={label} className="inline-flex">
          <Avatar initials={initials(label)} size={22} />
        </span>
      </GridPart>
      <GridPart role="cell" className={cn(CELL.menu, "flex justify-center px-1 max-lg:h-11 max-lg:items-center")}>
        <div className="opacity-100 transition-opacity focus-within:opacity-100 lg:opacity-0 lg:group-hover:opacity-100">
          <RowMenu row={row} actions={actions} open={open} />
        </div>
      </GridPart>
    </GridPart>
  );
}
