"use client";

import { Combobox } from "@base-ui/react/combobox";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon, useDebounced } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { productCopy } from "@/lib/i18n/product-copy";
import { type IssuePick, issuesApi } from "../api";

export type { IssuePick } from "../api";

/** The project's issues matching `text`, read once the person stops typing. */
function useIssuePick(projectId: string, text: string) {
  const q = useDebounced(text.trim(), 200);
  const query = useQuery({
    queryKey: ["issues", "pick", projectId, q],
    queryFn: () => issuesApi.pick(projectId, q),
    enabled: Boolean(projectId) && q.length > 0,
    staleTime: 15_000,
  });
  return { q, query };
}

/**
 * Picks issues of one project by searching their keys and titles, never by a key typed blind. Each
 * pick shows its key and title; `single` keeps the latest pick only. A search core refuses says so by
 * name in the list, and an empty search says nothing matched.
 */
export function IssuePicker({
  projectId,
  value,
  onChange,
  ariaLabel,
  single = false,
  id,
}: {
  projectId: string;
  value: IssuePick[];
  onChange: (next: IssuePick[]) => void;
  ariaLabel: string;
  single?: boolean;
  id?: string;
}) {
  const t = productCopy();
  const [text, setText] = useState("");
  const { q, query } = useIssuePick(projectId, text);
  const found = q.length > 0 ? (query.data ?? []) : [];
  const items = [...found, ...value.filter((v) => !found.some((f) => f.key === v.key))];
  const status = query.isFetching
    ? t("issues.picker.searching")
    : q.length === 0
      ? t("issues.picker.hint")
      : query.isSuccess && found.length === 0
        ? t("issues.picker.none", { text: q })
        : null;

  return (
    <Combobox.Root
      items={items}
      multiple
      value={value}
      filter={null}
      itemToStringLabel={(issue: IssuePick) => `${issue.key} ${issue.title}`}
      isItemEqualToValue={(a: IssuePick, b: IssuePick) => a.key === b.key}
      onValueChange={(next: IssuePick[]) => onChange(single ? next.slice(-1) : next)}
      onInputValueChange={(next) => setText(next)}
    >
      <Combobox.InputGroup className="flex min-h-9 w-full cursor-text flex-wrap items-center gap-1 rounded-md border border-line-strong bg-surface px-2 py-1 focus-within:border-[color:var(--link)] focus-within:shadow-[var(--shadow-focus)]">
        <Combobox.Chips className="flex w-full flex-wrap items-center gap-1">
          {value.map((issue) => (
            <Combobox.Chip
              key={issue.key}
              aria-label={`${issue.key} ${issue.title}`}
              className="flex max-w-full min-w-0 items-center gap-1.5 rounded-sm bg-sunken py-0.5 pr-0.5 pl-1.5 text-13 text-fg outline-none data-highlighted:bg-hover"
            >
              <span className="font-mono text-12 text-muted">{issue.key}</span>
              <span className="truncate">{issue.title}</span>
              <Combobox.ChipRemove
                aria-label={t("issues.picker.remove", { key: issue.key })}
                className="flex size-5 flex-none items-center justify-center rounded-sm text-subtle hover:bg-hover hover:text-fg"
              >
                <Icon name="x" size={12} />
              </Combobox.ChipRemove>
            </Combobox.Chip>
          ))}
          <Combobox.Input
            id={id}
            aria-label={ariaLabel}
            placeholder={value.length > 0 && single ? "" : t("issues.picker.placeholder")}
            className="h-7 min-w-24 flex-1 border-0 bg-transparent p-0 text-base text-fg outline-none placeholder:text-disabled md:text-sm"
          />
        </Combobox.Chips>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner className="z-50 outline-none" sideOffset={4}>
          <Combobox.Popup className="max-h-[min(var(--available-height),20rem)] w-[var(--anchor-width)] max-w-[var(--available-width)] overflow-y-auto rounded-lg border border-line bg-surface py-1 text-fg shadow-lg">
            <Combobox.Status className="block px-3 py-1.5 text-12 text-subtle">{status}</Combobox.Status>
            {query.isError ? <RefusalLine error={query.error} testid="issue-picker-refusal" /> : null}
            <Combobox.List className="divide-y divide-line-subtle">
              {(issue: IssuePick) => (
                <Combobox.Item
                  key={issue.key}
                  value={issue}
                  className="flex min-w-0 cursor-default items-baseline gap-2 px-3 py-2 text-13 outline-none select-none data-highlighted:bg-hover"
                >
                  <span className="flex-none font-mono text-12 text-muted">{issue.key}</span>
                  <span className="min-w-0 flex-1 truncate">{issue.title}</span>
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
