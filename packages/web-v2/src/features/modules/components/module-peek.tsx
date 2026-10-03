"use client";

// The peek (`?peek=outreach`) beside the list: the shared PeekPanel holding the page's header, the
// one line whom the module waits on, its open issues by state and activity, then the same facts the
// full page's sticky rail shows.

import { CoverageBar, ErrorState, PeekHead, PeekPanel, type PeekState, ProjectLoader } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useModuleDetail } from "../hooks";
import { ActivityBars, AttentionBadge, ModuleAction, ModuleBanner, openSegments } from "./module-bits";
import { ModuleFacts } from "./module-facts";

export function ModulePeek({
  projectId,
  slug,
  moduleSlug,
  peek,
  onOpenFull,
}: {
  projectId: string;
  slug: string;
  moduleSlug: string;
  peek: PeekState;
  onOpenFull: () => void;
}) {
  const q = useModuleDetail(projectId, moduleSlug);
  const d = q.data;
  return (
    <PeekPanel peek={peek} listLabel="Modules" noun="Module" onOpenFull={onOpenFull} testId="module-peek">
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading module…" />
        </div>
      ) : q.isError || !d ? (
        <div className="grid min-h-[40vh] place-items-center p-4">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : (
        <>
          <PeekHead noun="Module" itemKey={d.module.path} badge={<AttentionBadge group={d.standing.attentionGroup} />} title={d.module.name} action={<ModuleAction standing={d.standing} slug={slug} />} />
          {d.standing.attentionGroup !== "quiet" ? <ModuleBanner standing={d.standing} slug={slug} className="px-[18px]" /> : null}
          <div className="grid gap-4 px-[18px] pb-2 pt-4">
            {d.standing.open > 0 ? <CoverageBar segments={openSegments(d.standing)} /> : <p className="text-12-5 text-subtle">Nothing is open in this module.</p>}
            <div className="flex items-end justify-between gap-3">
              <span className="text-12-5 font-medium text-muted">Last {d.activity.days.length} days</span>
              <ActivityBars days={d.activity.days} height={24} barWidth={7} />
            </div>
          </div>
          <div className="px-[18px] pb-4 pt-3">
            <ModuleFacts d={d} slug={slug} />
          </div>
        </>
      )}
    </PeekPanel>
  );
}
