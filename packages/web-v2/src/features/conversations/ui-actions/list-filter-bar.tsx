"use client";

// Each list's filter, as one row in its toolbar (REQ-41 BC-5, BC-7): whom a row waits on (anyone, you,
// an agent, running), then every other field the URL holds as a removable chip. The list, the chat's
// `ui.<list>.filter` and these marks all read the same URL params (`UI_FILTER_PARAMS`), so a chip the
// assistant set reads orange until the person changes or removes it, and never after.

import {
  describeListFilter,
  listFilterFromSearch,
  UI_FILTER_PARAMS,
  UI_WAITING_FILTERS,
  type UiFilterField,
  type UiList,
  type UiListFilter,
  type UiWaitingFilter,
} from "@forge/contracts/ui-list-filters";
import { useMemo } from "react";
import { Icon } from "@/design";
import { writeUrlParams } from "@/design/hooks/use-url-params";
import { useAssistantSetFilter } from "@/features/chat-dock/assistant-filters";
import { useCopy } from "@/lib/i18n/interface-language";
import { cn } from "@/lib/utils/cn";
import { useLocationSearch } from "@/lib/utils/use-location-search";

/** The orange of a filter the assistant set, the same on every list. */
export const ASSISTANT_MARK = {
  borderColor: "var(--orange-500, #f97316)",
  color: "var(--orange-700, #c2410c)",
  background: "var(--orange-50, #fff7ed)",
};

/** The list's filter as its URL holds it now. */
export function useListFilter<L extends UiList>(list: L): UiListFilter<L> {
  const search = useLocationSearch();
  return useMemo(() => listFilterFromSearch(list, search), [list, search]);
}

/** Writes one field of the list's filter, or drops it with null; the page number goes with any change. */
export function setListParam(field: UiFilterField, value: string | null): void {
  writeUrlParams({ [UI_FILTER_PARAMS[field]]: value, page: null });
}

const WAITING_PARAM = UI_FILTER_PARAMS.waitingOn;

/** Anyone · You · An agent · Running: whom a row waits on, read from its standing (BC-5). */
export function WaitingFilter({ value }: { value: UiWaitingFilter | undefined }) {
  const t = useCopy();
  const assistantSet = useAssistantSetFilter();
  const options: { v: UiWaitingFilter | null; label: string }[] = [
    { v: null, label: t("conversations.list.waiting.any") },
    ...UI_WAITING_FILTERS.map((v) => ({ v, label: t(`conversations.list.waiting.${v}`) })),
  ];
  return (
    <fieldset className="m-0 flex items-center gap-1 border-0 p-0" data-testid="waiting-filter">
      <legend className="sr-only">{t("conversations.list.waiting")}</legend>
      <span aria-hidden className="text-12 text-subtle">
        {t("conversations.list.waiting")}
      </span>
      {options.map((o) => {
        const on = (value ?? null) === o.v;
        const marked = on && o.v !== null && assistantSet(WAITING_PARAM, o.v);
        return (
          <button
            key={o.v ?? "any"}
            type="button"
            aria-pressed={on}
            data-waiting={o.v ?? "any"}
            data-assistant={marked || undefined}
            onClick={() => setListParam("waitingOn", o.v)}
            className={cn(
              "inline-flex h-[26px] items-center rounded-pill border px-2.5 text-12 font-semibold",
              on ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
            )}
            style={marked ? ASSISTANT_MARK : undefined}
          >
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** Every field but whom a row waits on, as a chip the person can remove; orange while the assistant's value stands (BC-7). */
export function ListFilterChips({ filter }: { filter: Record<string, unknown> }) {
  const t = useCopy();
  const search = useLocationSearch();
  const assistantSet = useAssistantSetFilter();
  const sp = new URLSearchParams(search);
  const fields = (Object.keys(filter) as UiFilterField[]).filter((f) => f !== "waitingOn" && filter[f] !== undefined);
  if (fields.length === 0) return null;
  return (
    <>
      {fields.map((field) => {
        const param = UI_FILTER_PARAMS[field];
        const [words] = describeListFilter({ [field]: filter[field] });
        const label = words ? words.charAt(0).toUpperCase() + words.slice(1) : field;
        const marked = assistantSet(param, sp.get(param) ?? "");
        return (
          <span
            key={field}
            data-testid="list-filter-chip"
            data-field={field}
            data-assistant={marked || undefined}
            className="inline-flex items-center gap-1 rounded-pill border border-line bg-sunken px-2 py-0.5 text-12-5 font-semibold text-fg"
            style={marked ? ASSISTANT_MARK : undefined}
          >
            {label}
            <button type="button" aria-label={t("conversations.list.removeChip", { label })} onClick={() => setListParam(field, null)} className="leading-none">
              <Icon name="x" size={11} />
            </button>
          </span>
        );
      })}
    </>
  );
}

/** The waiting filter and the chips of one Product list, read from the URL. */
export function ListFilterBar({ list }: { list: Exclude<UiList, "issues"> }) {
  const filter = useListFilter(list) as Record<string, unknown>;
  return (
    <>
      <WaitingFilter value={filter.waitingOn as UiWaitingFilter | undefined} />
      <ListFilterChips filter={filter} />
    </>
  );
}

/** The list's filter less its search text, for a list whose own search box reads `q` already. */
export function useListNarrowing<L extends UiList>(list: L): Omit<UiListFilter<L>, "text"> {
  const filter = useListFilter(list);
  return useMemo(() => {
    const { text: _text, ...rest } = filter as UiListFilter<L> & { text?: unknown };
    return rest;
  }, [filter]);
}
