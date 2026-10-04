"use client";

import { useMemo } from "react";
import { DetailHeader, ErrorState, ProjectLoader, useListOrigin, useViewMode, ViewModeSwitcher } from "@/design";
import { formatApiError, isRetryableApiError } from "@/lib/api/error";
import { useModuleDetail, useModuleRollup } from "../hooks";
import { MODULES_LIST, moduleHref, modulesHref } from "../routes";
import { ancestorsOf } from "../tree";
import type { ModuleRollupRow } from "../types";
import { AttentionBadge, ModuleAction } from "./module-bits";
import { ModulePage, useModuleTab } from "./module-detail";
import { ModuleLevel } from "./module-level";

const VIEWS = [
  { value: "children" as const, label: "Modules", title: "Its child modules as a map and a list" },
  { value: "detail" as const, label: "Detail", title: "Its own issues, code and landings" },
];

function ModuleDetailBody({ projectId, slug, moduleSlug }: { projectId: string; slug: string; moduleSlug: string }) {
  const q = useModuleDetail(projectId, moduleSlug);
  const [tab, setTab] = useModuleTab();
  if (q.isLoading) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ProjectLoader label="loading module…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[40vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
      </div>
    );
  }
  return <ModulePage d={q.data} slug={slug} tab={tab} onTab={setTab} />;
}

// The shell's top bar is the page's sticky header (the shared DetailHeader): back to Modules, the
// module's ancestors, its path, name and attention badge; a module with children opens on them, the same
// map and list the Modules screen draws for the roots, and a leaf opens on its detail
export function ModuleScreen({ projectId, slug, moduleSlug }: { projectId: string; slug: string; moduleSlug: string }) {
  const q = useModuleRollup(projectId);
  const [view, setView] = useViewMode(VIEWS);
  const back = useListOrigin(MODULES_LIST, modulesHref(slug));
  const modules = q.data?.modules;
  const row = useMemo<ModuleRollupRow | undefined>(() => modules?.find((r) => r.slug === moduleSlug || r.id === moduleSlug), [modules, moduleSlug]);
  const trail = useMemo(
    () => (row && modules ? ancestorsOf(modules, row.id).map((a) => ({ href: moduleHref(slug, a.slug ?? a.id), label: a.name })) : []),
    [modules, row, slug],
  );
  const parent = row ? (row.standing.childCount > 0 ? row : null) : null;

  return (
    <div className="min-h-full bg-app" data-testid="module-screen">
      <DetailHeader
        back={{ href: back, label: "Modules" }}
        trail={trail}
        itemKey={row?.path ?? moduleSlug}
        keyTitle={row?.id}
        title={row?.name ?? moduleSlug}
        badge={row ? <AttentionBadge group={row.standing.attentionGroup} /> : null}
        views={parent ? <ViewModeSwitcher modes={VIEWS} value={view} onChange={setView} placement="header" /> : null}
        action={row ? <ModuleAction standing={row.standing} slug={slug} /> : null}
      />
      {q.isLoading ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ProjectLoader label="loading module…" />
        </div>
      ) : q.isError || !q.data ? (
        <div className="grid min-h-[40vh] place-items-center">
          <ErrorState message={formatApiError(q.error)} onRetry={isRetryableApiError(q.error) ? () => q.refetch() : undefined} />
        </div>
      ) : parent && view === "children" ? (
        <ModuleLevel
          projectId={projectId}
          slug={slug}
          data={q.data}
          scope={parent}
          toolbar={
            <div className="border-b border-line-subtle px-3 py-2.5 md:hidden">
              <ViewModeSwitcher modes={VIEWS} value={view} onChange={setView} placement="toolbar" />
            </div>
          }
        />
      ) : (
        <>
          {parent ? (
            <div className="border-b border-line-subtle px-5 py-2.5 md:hidden">
              <ViewModeSwitcher modes={VIEWS} value={view} onChange={setView} placement="toolbar" />
            </div>
          ) : null}
          <ModuleDetailBody projectId={projectId} slug={slug} moduleSlug={moduleSlug} />
        </>
      )}
    </div>
  );
}
