"use client";

import { ISSUE_ATTENTION_GROUPS, ISSUE_ATTENTION_LABELS } from "@forge/contracts/issue-standing";
import { OVERVIEW_FLOW_LABELS } from "@forge/contracts/development-overview";
import { Fragment } from "react";
import { CoverageBar, LEGEND, Tooltip } from "@/design";
import { partSegments, partsLine } from "../derive";
import type { OverviewFlow } from "../types";

export function AttentionLegend({ groups = ISSUE_ATTENTION_GROUPS }: { groups?: readonly (typeof ISSUE_ATTENTION_GROUPS)[number][] }) {
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-12 text-muted" aria-label="Legend">
      {groups.map((g) => (
        <li key={g} className="inline-flex items-center gap-1.5" title={ISSUE_ATTENTION_LABELS[g].hint ?? undefined}>
          <span aria-hidden className="size-2 rounded-[2px]" style={{ background: LEGEND[ISSUE_ATTENTION_LABELS[g].tone].dot }} />
          {ISSUE_ATTENTION_LABELS[g].label}
        </li>
      ))}
    </ul>
  );
}

export function IssueFlow({ flow }: { flow: OverviewFlow }) {
  if (flow.total === 0) return <p className="text-13 text-muted">No issue was touched in the last {flow.windowDays} days.</p>;
  return (
    <div data-testid="issue-flow">
      <ol className="flex items-stretch" aria-label="Issue flow">
        {flow.stages.map((s, i) => (
          <Fragment key={s.id}>
            {i > 0 ? (
              <li aria-hidden className="self-start px-1 text-12 leading-[10px] text-[var(--paper-400)]">
                →
              </li>
            ) : null}
            <li className="flex min-w-[52px] basis-0 flex-col" style={{ flexGrow: Math.max(s.count, 0.8) }} data-stage={s.id}>
              <Tooltip label={s.count ? partsLine(s.parts) : "Nothing here"}>
                <span className="block w-full">
                  {s.count ? (
                    <CoverageBar segments={partSegments(s.parts)} legend={false} />
                  ) : (
                    <span aria-hidden className="block h-2 rounded-pill bg-[var(--paper-200)]" />
                  )}
                </span>
              </Tooltip>
              <span className="mt-1 truncate text-12-5 font-medium text-muted">{OVERVIEW_FLOW_LABELS[s.id]}</span>
              <span className="font-mono text-13 font-bold tabular-nums text-fg">{s.count}</span>
            </li>
          </Fragment>
        ))}
      </ol>
      <AttentionLegend />
    </div>
  );
}
