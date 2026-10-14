"use client";

import Link from "next/link";
import {
  CardTitle,
  DataTable,
  type DataTableColumn,
  DotStrip,
  SectionTitle,
  Truncated,
  Waffle,
} from "@/design";
import { WORK_STATE_LABELS } from "@forge/contracts/work-state";
import { BUCKET_ORDER, bucketHref, formatElapsed, type ProjectSilenceRow, projectSilenceRows, waffleCells } from "../derive";
import type { PulseResponse } from "../types";

const LINK =
  "rounded-sm px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]";

// A project that never ran has been silent for longer than any that did, so it leads the longest-first order.
const SILENCE_COLUMNS: DataTableColumn<ProjectSilenceRow>[] = [
  {
    id: "project",
    header: "Project",
    sticky: true,
    sortValue: (r) => r.name,
    cell: (r) => (
      <Link href={`/projects/${r.slug}`} className={`${LINK} block`}>
        <Truncated text={r.name} />
      </Link>
    ),
  },
  ...BUCKET_ORDER.map<DataTableColumn<ProjectSilenceRow>>((b) => ({
    id: b,
    header: WORK_STATE_LABELS[b],
    align: "end",
    firstSort: "desc",
    sortValue: (r) => r.buckets[b],
    cell: (r) =>
      r.buckets[b] === 0 ? (
        <span className="text-disabled">0</span>
      ) : (
        <Link
          href={bucketHref(r.slug, b)}
          aria-label={`${r.name}: ${r.buckets[b]} ${WORK_STATE_LABELS[b]} — open the list`}
          className={LINK}
        >
          {r.buckets[b]}
        </Link>
      ),
  })),
  {
    id: "silence",
    header: "Last run",
    align: "end",
    firstSort: "desc",
    cellClassName: "text-muted",
    sortValue: (r) => (r.neverRan ? Number.POSITIVE_INFINITY : (r.silenceSeconds ?? 0)),
    cell: (r) => (r.neverRan ? "never ran" : formatElapsed(r.silenceSeconds)),
  },
];

export interface WorkSittingProps {
  pulse: PulseResponse;
  nowMs: number;
}

/** Section 2 — where is the work sitting? */
export function WorkSitting({ pulse, nowMs }: WorkSittingProps) {
  const cells = waffleCells(pulse.work.buckets);
  const rows = projectSilenceRows(pulse, nowMs);
  const ages = pulse.work.blockedOnPersonAges;

  return (
    <section aria-labelledby="overview-work" className="flex flex-col gap-4 border-t border-line pt-5">
      <SectionTitle id="overview-work" className="fg-h3">Where the work is sitting</SectionTitle>

      {cells.some((c) => c.count > 0) ? (
        <Waffle
          categories={cells.map((c) => ({
            key: c.key,
            label: c.label,
            count: c.count,
            color: c.color,
            onOpen: () => {
              document
                .getElementById("pulse-per-project")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            },
          }))}
        />
      ) : (
        <p className="fg-body-sm text-muted">No unfinished issues in scope.</p>
      )}

      {ages.length > 0 ? (
        <div className="flex flex-col gap-1">
          <CardTitle className="fg-body-sm text-muted">
            {WORK_STATE_LABELS.blocked_on_person} — {ages.length} {ages.length === 1 ? "issue" : "issues"}, oldest{" "}
            {formatElapsed(Math.max(...ages))}
          </CardTitle>
          <DotStrip
            items={ages.map((age, i) => ({
              key: `age-${i}`,
              value: age,
              label: `An issue waiting ${formatElapsed(age)}`,
            }))}
            axisLabels={["just blocked", `${formatElapsed(Math.max(...ages))} waiting`]}
          />
        </div>
      ) : null}

      <div id="pulse-per-project" className="flex flex-col gap-2">
        <CardTitle className="fg-body-sm text-muted">Longest without an issue run</CardTitle>
        {rows.length === 0 ? (
          <p className="fg-body-sm text-muted">No projects in scope.</p>
        ) : (
          <DataTable
            aria-label="Longest without an issue run"
            className="min-w-[32rem]"
            rows={rows}
            columns={SILENCE_COLUMNS}
            getRowId={(r) => r.id}
            defaultSort={{ id: "silence", desc: true }}
          />
        )}
      </div>
    </section>
  );
}
