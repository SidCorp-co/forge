"use client";

// The two ways to read a record page (REQ-43 BC-7): a person's, and a developer's. A person's view
// is the record's state; a developer's adds the agent text behind it — plans, criterion codes, shas,
// revision numbers, assistant drafts, agent memory, report ids. The choice rides `?view=` so a link
// to the developer view opens it.

import { useCopy } from "@/lib/i18n/interface-language";
import { useUrlChoice } from "../hooks/use-url-params";
import { SegmentedControl } from "../primitives/segmented-control";

export const RECORD_VIEWS = ["person", "developer"] as const;
export type RecordView = (typeof RECORD_VIEWS)[number];

/** `?view=` over the two views; the person's is the default and is not written. */
export function useRecordView(): [RecordView, (v: RecordView) => void] {
  return useUrlChoice<RecordView>("view", RECORD_VIEWS, "person");
}

export function RecordViewSwitch({ view, onView }: { view: RecordView; onView: (v: RecordView) => void }) {
  const t = useCopy();
  return (
    <span className="inline-flex" data-testid="record-view-switch">
      <SegmentedControl options={RECORD_VIEWS.map((v) => ({ value: v, label: t(`common.view.${v}`) }))} value={view} onChange={onView} />
    </span>
  );
}
