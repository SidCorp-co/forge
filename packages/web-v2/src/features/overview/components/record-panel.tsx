"use client";

import Link from "next/link";
import { useCopy } from "@/lib/i18n/interface-language";
import { ageText } from "../derive";

/** One record as the panel draws it, its detail already in the reader's words. */
export interface RecordView {
  key: string;
  label: string;
  detail: string;
  href: string;
  ageSeconds: number | null;
}

export interface RecordPanelProps {
  title: string;
  /** Every record the condition holds. */
  total: number;
  /** The records the response actually named. */
  records: RecordView[];
  onClose: () => void;
}

/**
 * The records behind one figure, listed.
 */
export function RecordPanel({ title, total, records, onClose }: RecordPanelProps) {
  const capped = records.length < total;
  const t = useCopy();
  return (
    <div className="mt-2 rounded-md border border-line-subtle bg-sunken p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="fg-body-sm font-medium">
          {capped ? t("overview.record.showing", { title, shown: records.length, total }) : `${title} — ${total}`}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="fg-body-sm rounded-sm px-1.5 py-0.5 text-muted hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
        >
          {t("common.close")}
        </button>
      </div>
      {records.length === 0 ? (
        <p className="fg-body-sm mt-2 text-muted">
          {t("overview.record.noneNamed", { n: total })}
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {records.map((r) => (
            <li key={r.key}>
              <Link
                href={r.href}
                className="fg-body-sm flex flex-wrap items-baseline gap-x-2 rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
              >
                <span className="font-medium">{r.label === "Run" ? t("overview.awaiting.runTitle") : r.label}</span>
                <span className="truncate text-muted">{r.detail}</span>
                {r.ageSeconds === null ? null : (
                  <span className="ml-auto shrink-0 tabular-nums text-subtle">
                    {ageText(r.ageSeconds, t)}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
