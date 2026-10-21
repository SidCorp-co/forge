"use client";

import { useState } from "react";
import {
  SectionTitle,
} from "@/design";
import { actionQueue, oldestText } from "../derive";
import type { ActionKey, ActionOwner } from "../derive";
import type { PulseResponse } from "../types";
import { RecordPanel } from "./record-panel";

const OWNER_TEXT: Record<ActionOwner, string> = {
  person: "A person unblocks this",
  machine: "The machine unblocks this",
};

export interface ActionQueueProps {
  pulse: PulseResponse;
  nowMs: number;
}

/** Section 3 — what needs a person? */
export function ActionQueue({ pulse, nowMs }: ActionQueueProps) {
  const [open, setOpen] = useState<ActionKey | null>(null);
  const rows = actionQueue(pulse, nowMs);

  return (
    <section aria-labelledby="overview-needs" className="flex flex-col gap-3 border-t border-line pt-5">
      <SectionTitle id="overview-needs" className="fg-h3">What needs someone</SectionTitle>

      {rows.length === 0 ? (
        <p className="fg-body-sm text-muted">
          Nothing is stuck, abandoned, waiting to release or gone quiet.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((row) => (
            <li key={row.key}>
              <button
                type="button"
                onClick={() => setOpen(open === row.key ? null : row.key)}
                aria-label={`${row.label}: ${row.count}${
                  oldestText(row) === null ? "" : `, ${oldestText(row)}`
                } — open the list`}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                {/* Narrow, the sentence takes the row's whole width and the figures go under it; from
                    sm up they sit in one line, the count first (ISS-1229 r27, judge-77 at 390). */}
                <span className="fg-body-sm min-w-0 basis-full sm:basis-0 sm:flex-1" data-queue-sentence>
                  <span className="block font-medium">{row.label}</span>
                  <span className="block text-muted">{row.hint}</span>
                </span>
                <span className="fg-h3 order-1 tabular-nums sm:order-first" data-queue-count>
                  {row.count}
                </span>
                <span className="fg-body-sm order-2 shrink-0 text-subtle sm:order-none">
                  {OWNER_TEXT[row.owner]}
                </span>
                {oldestText(row) === null ? null : (
                  <span className="fg-body-sm order-2 shrink-0 tabular-nums text-subtle sm:order-none" data-queue-oldest>
                    {oldestText(row)}
                  </span>
                )}
              </button>
              {open === row.key ? (
                <RecordPanel
                  title={row.label}
                  total={row.count}
                  records={row.records}
                  onClose={() => setOpen(null)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
