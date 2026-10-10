"use client";

import { ISSUE_ATTENTION_GROUPS, ISSUE_ATTENTION_LABELS } from "@forge/contracts/issue-standing";
import { Fragment } from "react";
import { CoverageBar, LEGEND, Tooltip } from "@/design";
import { useCopy } from "@/lib/i18n/interface-language";
import { partSegments, partsLine } from "../derive";
import type { OverviewFlow } from "../types";

function AttentionLegend({ groups = ISSUE_ATTENTION_GROUPS }: { groups?: readonly (typeof ISSUE_ATTENTION_GROUPS)[number][] }) {
  const t = useCopy();
  return (
    <ul className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-12 text-muted" aria-label={t("overview.dev.legend")}>
      {groups.map((g) => (
        <li key={g} className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-xs" style={{ background: LEGEND[ISSUE_ATTENTION_LABELS[g].tone].dot }} />
          {t(`issues.attention.${g}`)}
        </li>
      ))}
    </ul>
  );
}

export function IssueFlow({ flow }: { flow: OverviewFlow }) {
  const t = useCopy();
  if (flow.total === 0) return <p className="text-13 text-muted">{t("overview.dev.flowEmpty")}</p>;
  return (
    <div data-testid="issue-flow">
      <ol className="flex items-stretch" aria-label={t("overview.dev.flow")}>
        {flow.stages.map((s, i) => (
          <Fragment key={s.id}>
            {i > 0 ? (
              <li aria-hidden className="self-start px-1 text-12 leading-2.5 text-neutral-8">
                →
              </li>
            ) : null}
            <li className="flex min-w-13 basis-0 flex-col" style={{ flexGrow: Math.max(s.count, 0.8) }} data-stage={s.id}>
              <Tooltip label={s.count ? partsLine(s.parts, t) : t("overview.dev.nothingHere")}>
                <span className="block w-full">
                  {s.count ? (
                    <CoverageBar segments={partSegments(s.parts, t)} legend={false} />
                  ) : (
                    <span aria-hidden className="block h-2 rounded-pill bg-neutral-5" />
                  )}
                </span>
              </Tooltip>
              <span className="mt-1 truncate text-13 font-medium text-muted">{t(`overview.flow.${s.id}`)}</span>
              <span className="font-mono text-13 font-bold tabular-nums text-fg">{s.count}</span>
            </li>
          </Fragment>
        ))}
      </ol>
      <AttentionLegend />
    </div>
  );
}
