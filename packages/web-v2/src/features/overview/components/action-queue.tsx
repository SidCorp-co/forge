"use client";

import { useState } from "react";
import {
  PageSection,
  PageSectionBody,
  SectionTitle,
} from "@/design";
import type { PulseActionKey, PulseActionOwner } from "@forge/contracts/needs-you";
import { ageText } from "../derive";
import type { PulseResponse } from "../types";
import { RecordPanel } from "./record-panel";

const OWNER_TEXT: Record<PulseActionOwner, string> = {
  person: "A person unblocks this",
  machine: "The machine unblocks this",
};

export interface ActionQueueProps {
  pulse: PulseResponse;
}

/** Section 3 — what needs a person? */
export function ActionQueue({ pulse }: ActionQueueProps) {
  const [open, setOpen] = useState<PulseActionKey | null>(null);
  const rows = pulse.actions;

  return (
    <PageSection>
      <PageSectionBody className="flex flex-col gap-3">
        <SectionTitle className="fg-h3">What needs someone</SectionTitle>

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
                    row.oldestSeconds === null ? "" : `, oldest ${ageText(row.oldestSeconds)}`
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
                  {row.oldestSeconds === null ? null : (
                    <span className="fg-body-sm shrink-0 tabular-nums text-subtle">
                      oldest {ageText(row.oldestSeconds)}
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
      </PageSectionBody>
    </PageSection>
  );
}
