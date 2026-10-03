"use client";

// The peek (`#/requirements?peek=REQ-12`) beside the list: the full page's header — key, state,
// title, the one primary act — over the same facts its sticky rail shows.

import { Button, ErrorState, IconButton, Kbd, ProjectLoader } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useRequirement } from "../hooks";
import { rememberListOrigin } from "../routes";
import type { RequirementDetail } from "../types";
import { PrimaryActions } from "./requirement-actions";
import { RequirementFacts } from "./requirement-facts";
import { StateBadge, WaitBanner } from "./standing-bits";

export function RequirementPeek({
  projectId,
  slug,
  reqKey,
  position,
  onMove,
  onClose,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  reqKey: string;
  position: { at: number; of: number } | null;
  onMove: (by: number) => void;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  const q = useRequirement(projectId, reqKey);
  return (
    <aside
      className="fixed inset-0 z-30 flex flex-col overflow-y-auto border-line-subtle bg-app lg:sticky lg:inset-auto lg:top-0 lg:z-auto lg:h-[calc(100vh-48px)] lg:border-l"
      aria-label={`${reqKey} summary`}
      data-testid="requirement-peek"
    >
      <div className="sticky top-0 z-[3] flex items-center gap-1.5 border-b border-line-subtle bg-sunken px-3 py-2">
        <Button type="button" size="sm" className="lg:hidden" onClick={onClose}>
          ← Requirements
        </Button>
        <IconButton icon="arrowUp" size="sm" aria-label="Previous requirement (k)" disabled={!position || position.at <= 1} onClick={() => onMove(-1)} />
        <IconButton icon="arrowDown" size="sm" aria-label="Next requirement (j)" disabled={!position || position.at >= position.of} onClick={() => onMove(1)} />
        {position ? (
          <span className="mx-1 whitespace-nowrap font-mono text-11 text-subtle">
            {position.at} of {position.of}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button type="button" size="sm" onClick={onOpenFull} data-testid="open-full-page">
          Open full page ↗
        </Button>
        <IconButton icon="x" size="sm" aria-label="Close (Esc)" onClick={onClose} />
      </div>
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading requirement…" />
        </div>
      ) : q.isError || !q.data ? (
        <div className="grid min-h-[40vh] place-items-center p-4">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : (
        <PeekBody d={q.data} projectId={projectId} slug={slug} />
      )}
    </aside>
  );
}

function PeekBody({ d, projectId, slug }: { d: RequirementDetail; projectId: string; slug: string }) {
  const s = d.standing;
  const banner = s.waitingOn.kind === "you" || (s.attentionGroup === "stuck" && s.waitingOn.kind === "none");
  return (
    <>
      <div className="px-[18px] pb-3 pt-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-12 font-semibold text-muted" title={d.id}>
            {d.key}
          </span>
          <StateBadge state={s.state} />
        </div>
        <h2 className="mt-1.5 text-[17px] font-semibold leading-snug text-fg">{d.title}</h2>
        <div className="mt-2.5 empty:hidden">
          <PrimaryActions projectId={projectId} slug={slug} d={d} inPeek onReview={rememberListOrigin} />
        </div>
      </div>
      {banner ? <WaitBanner standing={s} className="px-[18px]" /> : null}
      <div className="px-[18px] pb-4 pt-4">
        <RequirementFacts d={d} slug={slug} />
      </div>
      <div className="mt-auto border-t border-line-subtle px-[18px] pb-4 pt-2.5 text-12 text-subtle max-lg:hidden">
        <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> full page · <Kbd>Esc</Kbd> close
      </div>
    </>
  );
}
