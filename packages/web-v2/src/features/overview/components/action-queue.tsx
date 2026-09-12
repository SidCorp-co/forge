"use client";

import { useState } from "react";
import { Card, CardContent } from "@/design";
import { actionQueue, formatElapsed } from "../derive";
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
    <Card>
      <CardContent className="flex flex-col gap-3">
        <h2 className="fg-h3">What needs someone</h2>

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
                  aria-label={`${row.label}: ${row.count}, oldest ${
                    row.oldestSeconds === Number.MAX_SAFE_INTEGER
                      ? "never ran"
                      : formatElapsed(row.oldestSeconds)
                  } — open the list`}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
                >
                  <span className="fg-h3 tabular-nums">{row.count}</span>
                  <span className="fg-body-sm min-w-0 flex-1">
                    <span className="block font-medium">{row.label}</span>
                    <span className="block text-muted">{row.hint}</span>
                  </span>
                  <span className="fg-body-sm shrink-0 text-subtle">
                    {OWNER_TEXT[row.owner]}
                  </span>
                  <span className="fg-body-sm shrink-0 tabular-nums text-subtle">
                    oldest{" "}
                    {row.oldestSeconds === Number.MAX_SAFE_INTEGER
                      ? "never ran"
                      : formatElapsed(row.oldestSeconds)}
                  </span>
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
      </CardContent>
    </Card>
  );
}
