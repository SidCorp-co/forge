"use client";

import { DetailHeader, ErrorState, ProjectLoader, useListOrigin } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useModuleDetail } from "../hooks";
import { MODULES_LIST, modulesHref } from "../routes";
import { AttentionBadge, ModuleAction } from "./module-bits";
import { ModulePage, useModuleTab } from "./module-detail";

// cm:why the shell's top bar is the page's sticky header (the shared DetailHeader): the named back control to
// Modules, the path, the name and the attention badge; the one primary act is opening the issue that waits on you
export function ModuleScreen({ projectId, slug, moduleSlug }: { projectId: string; slug: string; moduleSlug: string }) {
  const q = useModuleDetail(projectId, moduleSlug);
  const [tab, setTab] = useModuleTab();
  const back = useListOrigin(MODULES_LIST, modulesHref(slug));
  const d = q.data;
  return (
    <div className="min-h-full bg-app" data-testid="module-screen">
      <DetailHeader
        back={{ href: back, label: "Modules" }}
        itemKey={d?.module.path ?? moduleSlug}
        keyTitle={d?.module.id}
        title={d?.module.name ?? moduleSlug}
        badge={d ? <AttentionBadge group={d.standing.attentionGroup} /> : null}
        action={d ? <ModuleAction standing={d.standing} slug={slug} /> : null}
      />
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading module…" />
        </div>
      ) : q.isError || !d ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : (
        <ModulePage d={d} slug={slug} tab={tab} onTab={setTab} />
      )}
    </div>
  );
}
