"use client";

// The project's Memory page (MJ-1): every memory agents and people wrote down, found by its words,
// in three lists — current, those needing a check (nobody checked them for MEMORY_CHECK_AFTER_DAYS
// days, a record they cite changed since or no longer exists, or a release flagged them) and
// retired — each counted by core's one rule and read with who wrote it, when and whether it holds.

import { MEMORY_ENTRY_STATES, type MemoryEntryState } from "@forge/contracts/memory";
import { EmptyState, ErrorState, ListSearch, PageTitle, ProjectLoader, SegmentedControl, useUrlChoice, useUrlParams } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useMemoryActs, useMemoryEntries } from "../hooks";
import { MemoryEntryRow } from "./memory-entry";

export function MemoryScreen({ projectId, slug }: { projectId: string; slug: string }) {
  const t = useCopy();
  const [params, setParams] = useUrlParams();
  const [state, setState] = useUrlChoice("state", MEMORY_ENTRY_STATES, "live");
  const text = params.get("q") ?? "";
  const q = useMemoryEntries(projectId, { q: text, state: state as MemoryEntryState });
  const acts = useMemoryActs(projectId);
  const actError = acts.correct.error ?? acts.retire.error;

  return (
    <div className="grid min-h-full content-start bg-app" data-testid="memory-screen">
      <PageTitle hint={t("memory.hint")}>{t("memory.title")}</PageTitle>
      <div className="flex flex-wrap items-center gap-2 border-b border-line-subtle px-5 py-2.5 max-md:px-3">
        <SegmentedControl
          options={MEMORY_ENTRY_STATES.map((s) => {
            const label = t(`memory.state.${s}` as ProductCopyKey);
            return { value: s, label: q.data ? t("memory.stateCount", { state: label, n: q.data.counts[s] }) : label };
          })}
          value={state as MemoryEntryState}
          onChange={(s) => setState(s)}
        />
        <ListSearch noun={t("memory.searchNoun")} value={text} onChange={(v) => setParams({ q: v || null })} />
        {q.data ? <span className="text-12 text-subtle">{t("memory.count", { shown: q.data.returned, total: q.data.total })}</span> : null}
      </div>
      {actError ? <p className="px-5 py-2 text-13 text-danger">{formatApiError(actError)}</p> : null}
      {q.isError ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ErrorState title={t("memory.loadFailed")} message={formatApiError(q.error)} onRetry={() => q.refetch()} />
        </div>
      ) : !q.data ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label={t("memory.loading")} />
        </div>
      ) : q.data.items.length === 0 ? (
        <div className="px-5 py-10">
          <EmptyState title={t("memory.emptyTitle")} message={t("memory.emptyMessage")} />
        </div>
      ) : (
        <ul aria-label={t("memory.title")}>
          {q.data.items.map((e) => (
            <MemoryEntryRow
              key={e.id}
              entry={e}
              slug={slug}
              busy={acts.correct.isPending || acts.retire.isPending}
              onCorrect={(id, body) => acts.correct.mutate({ id, ...body })}
              onRetire={(id, body) => acts.retire.mutate({ id, ...body })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
