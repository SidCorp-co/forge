"use client";

import Link from "next/link";
import { Card, CardContent, DotStrip, Waffle } from "@/design";
import { bucketHref, formatElapsed, projectSilenceRows, waffleCells } from "../derive";
import { BUCKET_ORDER } from "../derive";
import { PULSE_BUCKET_LABELS } from "../types";
import type { PulseResponse } from "../types";

export interface WorkSittingProps {
  pulse: PulseResponse;
  nowMs: number;
}

/** Section 2 — where is the work sitting? */
// cm:guard the age dots carry NO door: `work.humanBlockedAges` is ages alone, so no exact list of those issues can be opened from here, and a dot that looked clickable would be an affordance over nothing (ISS-988 criteria 42-44). Giving them one means the response carrying their identities first.
export function WorkSitting({ pulse, nowMs }: WorkSittingProps) {
  const cells = waffleCells(pulse.work.buckets);
  const rows = projectSilenceRows(pulse, nowMs);
  const ages = pulse.work.humanBlockedAges;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <h2 className="fg-h3">Where the work is sitting</h2>

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
            <h3 className="fg-body-sm text-muted">
              Blocked on a person — {ages.length} {ages.length === 1 ? "issue" : "issues"}, oldest{" "}
              {formatElapsed(Math.max(...ages))}
            </h3>
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
          <h3 className="fg-body-sm text-muted">Longest without an issue run</h3>
          {rows.length === 0 ? (
            <p className="fg-body-sm text-muted">No projects in scope.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[32rem]">
                <thead>
                  <tr className="fg-body-sm text-subtle">
                    <th scope="col" className="py-1 text-left font-normal">Project</th>
                    {BUCKET_ORDER.map((b) => (
                      <th key={b} scope="col" className="py-1 text-right font-normal">
                        {PULSE_BUCKET_LABELS[b]}
                      </th>
                    ))}
                    <th scope="col" className="py-1 text-right font-normal">Last run</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="fg-body-sm border-t border-line-subtle">
                      <td className="py-1 text-left">
                        <Link
                          href={`/projects/${r.slug}`}
                          className="rounded-sm px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                        >
                          {r.name}
                        </Link>
                      </td>
                      {BUCKET_ORDER.map((b) => (
                        <td key={b} className="py-1 text-right tabular-nums">
                          {r.buckets[b] === 0 ? (
                            <span className="text-disabled">0</span>
                          ) : (
                            <Link
                              href={bucketHref(r.slug, b)}
                              aria-label={`${r.name}: ${r.buckets[b]} ${PULSE_BUCKET_LABELS[b]} — open the list`}
                              className="rounded-sm px-1 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                            >
                              {r.buckets[b]}
                            </Link>
                          )}
                        </td>
                      ))}
                      <td className="py-1 text-right tabular-nums text-muted">
                        {r.neverRan ? "never ran" : formatElapsed(r.silenceSeconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
