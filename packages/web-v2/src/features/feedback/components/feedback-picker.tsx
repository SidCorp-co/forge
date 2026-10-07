"use client";

import { Combobox } from "@base-ui/react/combobox";
import { useMemo, useState } from "react";
import { Icon } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { useFeedbackList } from "../hooks";
import type { FeedbackSummary } from "../types";

/** One feedback item as the picker offers it: the key a write names it by, and the title a person knows it by. */
export interface FeedbackPick {
  key: string;
  title: string;
}

/**
 * The items of `rows` that `text` names, an item a duplicate may point at: the item an exact key names
 * first, then those whose key or title holds the text, in the list's order. The item itself and a
 * declined item are never offered (core refuses a duplicate of either).
 */
export function feedbackMatches(rows: readonly FeedbackSummary[], text: string, self: string): FeedbackPick[] {
  const q = text.trim().toLowerCase();
  if (!q) return [];
  const open = rows.filter((r) => r.key !== self && r.phase !== "declined");
  const exact = open.filter((r) => r.key.toLowerCase() === q);
  const rest = open.filter((r) => r.key.toLowerCase() !== q && (r.key.toLowerCase().includes(q) || r.title.toLowerCase().includes(q)));
  return [...exact, ...rest].map((r) => ({ key: r.key, title: r.title }));
}

/**
 * Picks one feedback item of the project by searching its keys and titles, never by a key typed
 * blind. The pick shows its key and title; an empty search says nothing matched, and a list core
 * refuses to read says so by name.
 */
export function FeedbackPicker({
  projectId,
  self,
  value,
  onChange,
  id,
}: {
  projectId: string;
  /** The item being triaged, never offered as its own original. */
  self: string;
  value: FeedbackPick | null;
  onChange: (next: FeedbackPick | null) => void;
  id?: string;
}) {
  const t = useCopy();
  const list = useFeedbackList(projectId);
  const [text, setText] = useState("");
  const q = text.trim();
  const found = useMemo(() => feedbackMatches(list.data?.feedback ?? [], q, self), [list.data, q, self]);
  const picked = value ? [value] : [];
  const items = [...found, ...picked.filter((v) => !found.some((f) => f.key === v.key))];
  const status = list.isLoading
    ? t("feedback.picker.loading")
    : q.length === 0
      ? t("feedback.picker.hint")
      : list.isSuccess && found.length === 0
        ? t("feedback.picker.none", { text: q })
        : null;

  return (
    <Combobox.Root
      items={items}
      multiple
      value={picked}
      filter={null}
      itemToStringLabel={(f: FeedbackPick) => `${f.key} ${f.title}`}
      isItemEqualToValue={(a: FeedbackPick, b: FeedbackPick) => a.key === b.key}
      onValueChange={(next: FeedbackPick[]) => onChange(next.at(-1) ?? null)}
      onInputValueChange={(next) => setText(next)}
    >
      <Combobox.InputGroup className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 focus-within:border-[color:var(--link)] focus-within:shadow-[var(--shadow-focus)]">
        <Combobox.Chips className="flex w-full flex-wrap items-center gap-1">
          {picked.map((f) => (
            <Combobox.Chip
              key={f.key}
              aria-label={`${f.key} ${f.title}`}
              className="flex max-w-full min-w-0 items-center gap-1.5 rounded-sm bg-sunken py-0.5 pr-0.5 pl-1.5 text-13 text-fg outline-none data-highlighted:bg-hover"
            >
              <span className="font-mono text-12 text-muted">{f.key}</span>
              <span className="truncate">{f.title}</span>
              <Combobox.ChipRemove
                aria-label={t("feedback.picker.remove", { key: f.key })}
                className="flex size-5 flex-none items-center justify-center rounded-sm text-subtle hover:bg-hover hover:text-fg"
              >
                <Icon name="x" size={12} />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          ))}
          <Combobox.Input
            id={id}
            aria-label={t("feedback.picker.aria")}
            placeholder={value ? "" : t("feedback.picker.placeholder")}
            className="h-7 min-w-24 flex-1 border-0 bg-transparent p-0 text-base text-fg outline-none placeholder:text-disabled md:text-sm"
          />
        </Combobox.Chips>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" sideOffset={4}>
          <Combobox.Popup className="max-h-[min(var(--available-height),20rem)] w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-y-auto rounded-lg border border-line bg-surface py-1 text-fg shadow-lg">
            <Combobox.Status className="block px-3 py-1.5 text-12 text-subtle">{status}</Combobox.Status>
            {list.isError ? <RefusalLine error={list.error} testid="feedback-picker-refusal" /> : null}
            <Combobox.List className="divide-y divide-line-subtle">
              {(f: FeedbackPick) => (
                <Combobox.Item
                  key={f.key}
                  value={f}
                  className="flex min-w-0 cursor-default items-baseline gap-2 px-3 py-2 text-13 outline-none select-none data-highlighted:bg-hover"
                >
                  <span className="flex-none font-mono text-12 text-muted">{f.key}</span>
                  <span className="min-w-0 flex-1 truncate">{f.title}</span>
                  <Combobox.ItemIndicator className="flex-none text-accent">
                    <Icon name="check" size={13} />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
