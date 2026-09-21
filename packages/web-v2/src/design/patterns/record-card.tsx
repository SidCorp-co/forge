"use client";

// The reader's half of the one parse. Core parses the ```forge-record fence a
// comment carries and ships the result on the comment node; nothing here parses
// anything, because a second parser in the browser could disagree with the one
// that screened the comment at the write door (ISS-1089).
//
// The lead is the first line, each field is a row, and a field past its budget
// is FOLDED and never cut. Nothing is hidden from anybody: the lens the card is
// given decides only which of those rows are open before a reader touches them.

import type { ForgeRecordFieldView, ForgeRecordView, RecordLens } from "@forge/contracts";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils/cn";

export interface RecordCardProps {
  record: ForgeRecordView;
  /** Which reading the project is drawn under; `product` where it is unknown. */
  lens?: RecordLens;
  className?: string;
}

/** `judge-from` → `judge from`. The key is the only label a field has. */
function fieldLabel(key: string): string {
  return key.replace(/-/g, " ");
}

function Kind({ record }: { record: ForgeRecordView }): ReactNode {
  if (!record.kind) return null;
  return (
    <span className="fg-caption rounded-sm border border-line-subtle bg-sunken px-1.5 py-0.5 font-mono text-muted">
      {record.kind}
      {record.contract === null ? null : ` · contract ${record.contract}`}
    </span>
  );
}

function Field({ field, open }: { field: ForgeRecordFieldView; open: boolean }): ReactNode {
  const [shown, setShown] = useState(open);
  const body = (
    <div className="fg-body-sm whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">
      {field.value}
    </div>
  );
  return (
    <div className="grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-line-subtle px-3 py-2 last:border-b-0">
      <div className="fg-caption min-w-0 break-words pt-0.5 font-mono text-muted [overflow-wrap:anywhere]">
        {fieldLabel(field.key)}
      </div>
      {field.over > 0 ? (
        <details
          className="min-w-0"
          open={shown}
          onToggle={(e) => setShown((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="fg-caption cursor-pointer text-muted">
            {shown ? "Fold" : `Show all — ${field.over} character(s) over budget`}
          </summary>
          <div className="mt-1">{body}</div>
        </details>
      ) : (
        <div className="min-w-0">{body}</div>
      )}
    </div>
  );
}

/** Each field with a key of its own: its name, and how many of that name preceded it. */
function keyed(
  fields: readonly ForgeRecordFieldView[],
): Array<[string, ForgeRecordFieldView]> {
  const seen = new Map<string, number>();
  return fields.map((field) => {
    const at = seen.get(field.key) ?? 0;
    seen.set(field.key, at + 1);
    return [`${field.key}#${at}`, field];
  });
}

export function RecordCard({ record, lens = "product", className }: RecordCardProps): ReactNode {
  const lead = record.lead;
  return (
    <section
      className={cn("my-3 rounded-md border border-line bg-surface first:mt-0", className)}
      data-testid="forge-record-card"
      data-lens={lens}
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-3 py-2">
        <Kind record={record} />
        {lead === null ? null : <span className="fg-body-sm min-w-0 flex-1 text-fg">{lead}</span>}
      </header>
      <div>
        {keyed(record.fields).map(([id, field]) => (
          <Field
            key={id}
            field={field}
            open={lens === "technical"}
          />
        ))}
      </div>
    </section>
  );
}
