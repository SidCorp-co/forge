"use client";

import { Button, EmptyState, ErrorState, PageTitle, ProjectLoader } from "@/design";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { useQueryParam } from "@/lib/utils/use-query-param";
import { FILTER_LABEL, filterCount, matchesFilter } from "../version-status";
import { useCutRelease, useReleaseVersions } from "../versions-hooks";
import { VERSION_FILTERS, type ReleaseVersionFilter } from "../versions-types";
import { EnvironmentStrip } from "./environment-strip";
import { DraftDetail, VersionDetail } from "./version-detail";
import { VersionList } from "./version-list";
import { TopBarActions } from "@/design/primitives/top-bar-slot";

export interface ReleasesScreenProps {
  projectId: string;
  isAdmin: boolean;
}

export function ReleasesScreen({ projectId, isAdmin }: ReleasesScreenProps) {
  const q = useReleaseVersions(projectId);
  const cut = useCutRelease(projectId);
  const [rawFilter, setFilter] = useQueryParam("f");
  const [picked, setPicked] = useQueryParam("v");
  const filter: ReleaseVersionFilter = (VERSION_FILTERS as readonly string[]).includes(rawFilter ?? "")
    ? (rawFilter as ReleaseVersionFilter)
    : "all";

  if (q.isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading releases…" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(q.error)} onRetry={() => q.refetch()} />
      </div>
    );
  }
  const list = q.data;
  const shown = list.versions.filter((v) => matchesFilter(v, filter));
  const draft = filter === "all" ? list.draft : null;
  const fallback = draft?.version ?? shown[0]?.version ?? null;
  const selected =
    picked && (picked === draft?.version || shown.some((v) => v.version === picked)) ? picked : fallback;
  const draftCuttable = isAdmin && list.draft !== null && list.draft.blockers.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="releases-screen">
      <PageTitle>Releases</PageTitle>
      {list.draft && isAdmin ? (
          <TopBarActions>
            <Button
              size="sm"
              disabled={!draftCuttable || cut.isPending}
              title={list.draft.blockers.map((b) => b.message).join("\n") || undefined}
              onClick={() => list.draft && cut.mutate(list.draft.issues.map((i) => i.id))}
            >
              Cut {list.draft.version}
            </Button>
          </TopBarActions>
        ) : null}
      <EnvironmentStrip list={list} />
      <fieldset className="flex flex-wrap gap-1.5 border-0 px-4 pb-3 sm:px-7" aria-label="Filter versions" data-testid="version-filters">
        {VERSION_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f === "all" ? null : f)}
            className={cn(
              "rounded-pill border px-3 py-0.5 text-12 font-semibold",
              filter === f ? "border-fg bg-fg text-surface" : "border-line bg-surface text-muted hover:text-fg",
            )}
          >
            {FILTER_LABEL[f]} {filterCount(list.counts, f)}
          </button>
        ))}
      </fieldset>
      {shown.length === 0 && !draft ? (
        <div className="border-t border-line-subtle p-8">
          <EmptyState
            title={filter === "all" ? "No version has been cut" : `No version is ${FILTER_LABEL[filter].toLowerCase()}`}
            message={
              filter === "all"
                ? "A version is cut when merged issues waiting at the release gate are released together. None is waiting, and none has been cut on this project."
                : "Pick another filter to see the other versions."
            }
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 border-t border-line-subtle md:grid-cols-[400px_minmax(0,1fr)]">
          <VersionList versions={shown} draft={draft} selected={selected} onSelect={(v) => setPicked(v)} />
          {selected && draft && selected === draft.version ? (
            <DraftDetail projectId={projectId} draft={draft} canCut={isAdmin} />
          ) : selected ? (
            <VersionDetail projectId={projectId} version={selected} canDecide={isAdmin} />
          ) : null}
        </div>
      )}
    </div>
  );
}
