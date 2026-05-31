"use client";

// web-v2 Activity feed (`/v2/activity`). Cross-project agent-handoff timeline
// (verb + detail + stage hue + time) with a context rail (today's stats +
// per-stage legend). New events flash via Highlight on WS; skeleton on load.
// Mirrors the prototype ListScreens.jsx (activity). Also reusable at the
// project tier via `scope.projectId`.
import { useMemo } from "react";
import { EmptyState, ErrorState, SessionRowSkeleton } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { projectRoom } from "@/lib/ws/rooms";
import { useRoom } from "@/lib/ws/use-room";
import { ActivityContextRail } from "./activity-context-rail";
import { ActivityRow } from "./activity-row";
import { useActivityFeed } from "../hooks";

function RoomSub({ projectId }: { projectId: string }) {
  useRoom(projectRoom(projectId));
  return null;
}

export function ActivityScreen({ scope }: { scope?: { projectId?: string } } = {}) {
  const projectId = scope?.projectId;
  const feed = useActivityFeed({ projectId });
  const projectsQ = useProjects();
  const now = Date.now();

  const rooms = useMemo(() => {
    const all = projectsQ.data ?? [];
    return projectId ? all.filter((p) => p.id === projectId) : all;
  }, [projectsQ.data, projectId]);

  return (
    <div className="mx-auto w-full min-h-dvh max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      {rooms.map((p) => (
        <RoomSub key={p.id} projectId={p.id} />
      ))}

      <header className="mb-6">
        <h1 className="fg-h2">Activity</h1>
        <p className="fg-body-sm mt-1">
          {projectId
            ? "Agent handoffs and changes in this project."
            : "Agent handoffs and changes across your workspace."}
        </p>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_280px]">
        <div className="min-w-0">
          {feed.isLoading && (
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              {Array.from({ length: 8 }).map((_, i) => (
                <SessionRowSkeleton key={i} />
              ))}
            </div>
          )}

          {!feed.isLoading && feed.isError && (
            <ErrorState
              title="Couldn't load activity"
              message="We couldn't reach the activity service. Retry in a moment."
              onRetry={() => feed.refetch()}
            />
          )}

          {!feed.isLoading && !feed.isError && feed.rows.length === 0 && (
            <EmptyState
              title="No activity yet"
              message="Agent handoffs, status changes, and comments will stream in here as the pipeline runs."
            />
          )}

          {!feed.isLoading && !feed.isError && feed.rows.length > 0 && (
            <div className="divide-y divide-line-subtle rounded-lg border border-line bg-surface px-4">
              {feed.rows.map((row) => (
                <ActivityRow key={`${row.projectId}:${row.id}`} row={row} now={now} />
              ))}
            </div>
          )}
        </div>

        {/* Context rail — hidden on narrow viewports to avoid horizontal scroll. */}
        <aside className="hidden lg:block">
          <ActivityContextRail rows={feed.rows} now={now} />
        </aside>
      </div>
    </div>
  );
}
