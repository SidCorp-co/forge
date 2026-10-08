"use client";

// REQ-33 BC-4, BC-5, BC-7: what agents and people wrote down about one requirement, workflow or
// issue, read on that item and nowhere else — or, naming none, about the project, read on its Dashboard: each memory naming it, with who wrote it, when, when it was last
// checked and what it names that is gone or changed, and the acts that keep it true (still true,
// correct or retire, each correction and retirement with a reason). Flat: hairline rows, no cards.

import { useState } from "react";
import { Button, ErrorState, ProjectLoader, ViewHeading } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useItemMemory, useMemoryActs } from "../hooks";
import { MemoryEntryRow } from "./memory-entry";

/** How many memories name the item, for its tab; undefined until the read answers. */
export function useItemMemoryCount(projectId: string, cites: string): number | undefined {
  return useItemMemory(projectId, { cites, state: "live" }).data?.counts.live;
}

/** The memories naming `cites`, or, with `cites` null, the project's own that name no item of it (REQ-33 BC-7). */
export function ItemMemory({ projectId, slug, cites }: { projectId: string; slug: string; cites: string | null }) {
  const t = useCopy();
  const [retired, setRetired] = useState(false);
  const q = useItemMemory(projectId, { cites, state: retired ? "retired" : "live" });
  const acts = useMemoryActs(projectId);
  const actError = acts.correct.error ?? acts.retire.error ?? acts.verify.error;
  const busy = acts.correct.isPending || acts.retire.isPending || acts.verify.isPending;
  const hidden = q.data ? (retired ? q.data.counts.live : q.data.counts.retired) : 0;
  return (
    <section className="grid gap-3" data-testid="item-memory" aria-label={t("memory.title")}>
      <ViewHeading hint={cites === null ? t("memory.projectHint") : t("memory.itemHint", { ref: cites })}>{t("memory.title")}</ViewHeading>
      {actError ? <p className="text-13 text-danger">{formatApiError(actError)}</p> : null}
      {q.isError ? (
        <ErrorState title={t("memory.loadFailed")} message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      ) : !q.data ? (
        <ProjectLoader label={t("memory.loading")} />
      ) : q.data.items.length === 0 ? (
        <p className="text-13 text-subtle">{retired ? t("memory.itemNoneRetired") : cites === null ? t("memory.projectNone") : t("memory.itemNone", { ref: cites })}</p>
      ) : (
        <ul className="-mx-5 border-t border-line-subtle max-md:-mx-3">
          {q.data.items.map((e) => (
            <MemoryEntryRow
              key={e.id}
              entry={e}
              slug={slug}
              busy={busy}
              onVerify={(id) => acts.verify.mutate([id])}
              onCorrect={(id, body) => acts.correct.mutate({ id, ...body })}
              onRetire={(id, body) => acts.retire.mutate({ id, ...body })}
            />
          ))}
        </ul>
      )}
      {q.data && (retired || hidden > 0) ? (
        <p className="flex flex-wrap items-baseline gap-x-2 text-12-5 text-muted" data-testid="item-memory-retired">
          <span>{retired ? t("memory.itemShowingRetired") : t("memory.itemRetired", { n: hidden })}</span>
          <Button size="sm" variant="ghost" onClick={() => setRetired((r) => !r)}>
            {retired ? t("memory.itemShowCurrent") : t("memory.itemShowRetired")}
          </Button>
        </p>
      ) : null}
    </section>
  );
}
