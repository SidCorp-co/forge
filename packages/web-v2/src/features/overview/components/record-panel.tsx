"use client";

import Link from "next/link";
import type { ActionRecord } from "../derive";
import { formatElapsed } from "../derive";

export interface RecordPanelProps {
  title: string;
  /** Every record the condition holds. */
  total: number;
  /** The records the response actually named. */
  records: ActionRecord[];
  onClose: () => void;
}

/**
 * The records behind one figure, listed.
 */
// cm:guard where `records.length < total` the panel says both numbers: the response caps its identity lists, and a panel that presents the capped set as the whole is the truncation-as-truth defect this criterion exists to refuse (ISS-988 criterion 46).
export function RecordPanel({ title, total, records, onClose }: RecordPanelProps) {
  const capped = records.length < total;
  return (
    <div className="mt-2 rounded-md border border-line-subtle bg-sunken p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="fg-body-sm font-medium">
          {capped ? `${title} — showing ${records.length} of ${total}` : `${title} — ${total}`}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="fg-body-sm rounded-sm px-1.5 py-0.5 text-muted hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          Close
        </button>
      </div>
      {records.length === 0 ? (
        <p className="fg-body-sm mt-2 text-muted">
          The response counted {total} but named none of them.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {records.map((r) => (
            <li key={r.key}>
              <Link
                href={r.href}
                className="fg-body-sm flex flex-wrap items-baseline gap-x-2 rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                <span className="font-medium">{r.label}</span>
                <span className="truncate text-muted">{r.detail}</span>
                <span className="ml-auto shrink-0 tabular-nums text-subtle">
                  {r.ageSeconds === Number.MAX_SAFE_INTEGER
                    ? "never ran"
                    : formatElapsed(r.ageSeconds)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
