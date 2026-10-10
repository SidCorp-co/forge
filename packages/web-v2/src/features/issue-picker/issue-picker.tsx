"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ChipPicker, useDebounced } from "@/design";
import { RefusalLine } from "@/lib/api/refusal-line";
import { useCopy } from "@/lib/i18n/interface-language";
import { type IssuePick, pickIssues } from "./api";

export type { IssuePick } from "./api";

/** The project's issues matching `text`, read once the person stops typing. */
function useIssuePick(projectId: string, text: string) {
  const q = useDebounced(text.trim(), 200);
  const query = useQuery({
    queryKey: ["issues", "pick", projectId, q],
    queryFn: () => pickIssues(projectId, q),
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
}: {
  projectId: string;
  value: IssuePick[];
  onChange: (next: IssuePick[]) => void;
  ariaLabel: string;
  single?: boolean;
}) {
  const t = useCopy();
  const [text, setText] = useState("");
  const { q, query } = useIssuePick(projectId, text);
  const found = q.length > 0 ? (query.data ?? []) : [];
  const items = [...found, ...value.filter((v) => !found.some((f) => f.key === v.key))];
  const status = query.isFetching
    ? t("issues.picker.searching")
    : q.length > 0 && query.isSuccess && found.length === 0
      ? t("issues.picker.none")
      : null;

  return (
    <ChipPicker
      value={value}
      onChange={onChange}
      items={items}
      single={single}
      itemKey={(issue) => issue.key}
      itemLabel={(issue) => `${issue.key} ${issue.title}`}
      renderItem={(issue) => (
        <>
          <span className="flex-none font-mono text-12 text-muted">{issue.key}</span>
          <span className="min-w-0 truncate">{issue.title}</span>
        </>
      )}
      onInputChange={setText}
      ariaLabel={ariaLabel}
      placeholder={t("issues.picker.placeholder")}
      removeLabel={(issue) => t("issues.picker.remove", { key: issue.key })}
      status={status}
      error={query.isError ? <RefusalLine error={query.error} testid="issue-picker-refusal" /> : null}
    />
  );
}
