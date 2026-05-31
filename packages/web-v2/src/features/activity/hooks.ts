"use client";

// web-v2 feature module: activity — React Query hooks.
//
// Query-key contract (ISS-296): every key starts with `['activity']`, which the
// WS event-router invalidates on `issue.*` / `comment.*` / `agent-session.*`
// and on `replayOnReconnect`. The cross-project feed fans out one query per
// project but keeps them under the shared `['activity','feed', …]` prefix so a
// single invalidation refreshes the whole feed.
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useProjects } from "@/features/projects/hooks";
import { activityApi } from "./api";
import type { FeedRow } from "./types";

export interface ActivityFeedOpts {
  /** Scope to one project; omit for the cross-project workspace feed. */
  projectId?: string;
  /** Per-project page size (the merged feed shows the most recent across all). */
  limit?: number;
}

export interface ActivityFeed {
  rows: FeedRow[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

/**
 * Cross-project (or single-project) activity feed. Fans `GET .../activity` over
 * the caller's projects, tags each row with its project, then merges + sorts by
 * `createdAt` desc. Bounded by the caller's project count.
 */
export function useActivityFeed({ projectId, limit = 40 }: ActivityFeedOpts = {}): ActivityFeed {
  const projectsQ = useProjects();
  const projects = useMemo(() => {
    const all = projectsQ.data ?? [];
    return projectId ? all.filter((p) => p.id === projectId) : all;
  }, [projectsQ.data, projectId]);

  const results = useQueries({
    queries: projects.map((p) => ({
      queryKey: ["activity", "feed", p.id, limit],
      queryFn: () => activityApi.projectActivity(p.id, { limit }),
    })),
  });

  const rows = useMemo(() => {
    const out: FeedRow[] = [];
    results.forEach((res, i) => {
      const project = projects[i];
      if (!project || !res.data) return;
      for (const row of res.data.items) {
        out.push({ ...row, projectId: project.id, projectName: project.name });
      }
    });
    out.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return out;
  }, [results, projects]);

  return {
    rows,
    isLoading: projectsQ.isLoading || results.some((r) => r.isLoading),
    isError: projectsQ.isError || results.some((r) => r.isError),
    refetch: () => {
      projectsQ.refetch();
      results.forEach((r) => r.refetch());
    },
  };
}
