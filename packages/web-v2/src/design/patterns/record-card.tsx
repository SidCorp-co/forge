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
  // cm:guard the label follows the ACTUAL disclosure state and not the lens it started in. Native
  // `<details>` opens and closes without React, so a label derived from the prop alone tells an
  // expanded product field to "Show all" and a collapsed technical one to "Fold" — the summary
  // naming the opposite of what pressing it does (codex F4).
  const [shown, setShown] = useState(open);
  const body = (
    <div className="fg-body-sm whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">
      {field.value}
    </div>
  );
  return (
    <div className="grid grid-cols-[minmax(4.5rem,max-content)_1fr] gap-x-3 gap-y-1 border-b border-line-subtle px-3 py-2 last:border-b-0">
      <div className="fg-caption pt-0.5 font-mono text-muted">{fieldLabel(field.key)}</div>
      {field.over > 0 ? (
        // cm:guard `<details>` and not a height clamp: the whole value is in the DOM either way, so
        // a reader searching the page finds it and a copy takes all of it. A clamp that renders
        // fewer characters is the truncation this card exists not to do.
        <details
          open={shown}
          onToggle={(e) => setShown((e.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="fg-caption cursor-pointer text-muted">
            {shown ? "Fold" : `Show all — ${field.over} character(s) over budget`}
          </summary>
          <div className="mt-1">{body}</div>
        </details>
      ) : (
        body
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
  // cm:guard a record carrying no `lead` draws NO lead line and nothing standing in for one. Taking
  // the first field's text as a headline is the substitution the parse refuses to make one layer
  // down, and it would put a sentence in the reader's eye that no writer composed.
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
            // cm:guard the key counts how many fields of this name came BEFORE it, rather than
            // being the array index or the bare key. A key repeated inside one fence is two fields,
            // which is what the writer wrote, so `field.key` alone is a duplicate React key across
            // siblings: both rows still draw, which is why it is easy to ship, and what goes wrong
            // is reconciliation — on a re-render React may match a row to the wrong sibling and an
            // open fold moves to a field the reader did not open.
            key={id}
            field={field}
            open={lens === "technical"}
          />
        ))}
      </div>
    </section>
  );
}
