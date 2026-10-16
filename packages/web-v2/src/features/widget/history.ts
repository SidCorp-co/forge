import type { WidgetFeedbackDraft, WidgetFiled, WidgetHistory, WidgetMessage } from "@forge/contracts/widget";

// The conversation lives in the query cache as core's own `WidgetHistory`; each stream event folds
// into it here, by id, so the history read and the live stream never show a line twice.

export const EMPTY_HISTORY: WidgetHistory = { messages: [], drafts: [] };

const byTime = (a: WidgetMessage, b: WidgetMessage) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id);

export function withMessage(history: WidgetHistory | undefined, message: WidgetMessage): WidgetHistory {
  const base = history ?? EMPTY_HISTORY;
  const messages = [...base.messages.filter((m) => m.id !== message.id), message].sort(byTime);
  return { ...base, messages };
}

export function withDraft(history: WidgetHistory | undefined, draft: WidgetFeedbackDraft): WidgetHistory {
  const base = history ?? EMPTY_HISTORY;
  const at = base.drafts.findIndex((d) => d.draftId === draft.draftId);
  const drafts = at === -1 ? [...base.drafts, draft] : base.drafts.map((d, i) => (i === at ? draft : d));
  return { ...base, drafts };
}

/** A draft the visitor sent: it reads filed, and carries the status link core gave for it. */
export function withFiled(history: WidgetHistory | undefined, draftId: string, filed: WidgetFiled): WidgetHistory {
  const base = history ?? EMPTY_HISTORY;
  return { ...base, drafts: base.drafts.map((d) => (d.draftId === draftId ? { ...d, state: "filed", filed } : d)) };
}

const SETTLED: readonly WidgetFeedbackDraft["state"][] = ["filed", "discarded"];

/**
 * A history core answered, folded over what the stream already put in the cache: a read that left
 * before an event arrived must not take that event back. Messages join by id; a draft keeps the
 * state that is further on, since a draft never goes back to pending, and a filed draft keeps the
 * status link either side holds.
 */
export function mergeHistory(cached: WidgetHistory | undefined, read: WidgetHistory): WidgetHistory {
  if (!cached) return read;
  let merged: WidgetHistory = read;
  for (const message of cached.messages) if (!read.messages.some((m) => m.id === message.id)) merged = withMessage(merged, message);
  for (const draft of cached.drafts) {
    const was = read.drafts.find((d) => d.draftId === draft.draftId);
    if (!was || (was.state === "pending" && SETTLED.includes(draft.state))) merged = withDraft(merged, draft);
    else if (was.state === "filed" && !was.filed && draft.filed) merged = withDraft(merged, { ...was, filed: draft.filed });
  }
  return merged;
}
