"use client";

import Link from "next/link";
import {
  Card,
  ProjectMark,
  Badge,
  Stat,
  EmptyState,
  ErrorState,
  ProjectCardSkeleton,
} from "@/design";
import { useProjects } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import { formatApiError } from "@/lib/api/error";

/**
 * Workspace landing = the Projects console. This is the foundation's "sample
 * live query": `useProjects()` is keyed `['projects']`, which the WS
 * event-router invalidates on reconnect — so the list refreshes itself on a
 * live event with no bespoke wiring.
 */
export default function ProjectsConsolePage() {
  const { data: projects, isLoading, isError, error, refetch } = useProjects();

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-8">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="fg-h2">Projects</h1>
          <p className="fg-body-sm mt-1">Every project you can reach in this workspace.</p>
        </div>
        {projects && projects.length > 0 && (
          <Badge tone="neutral">{projects.length} total</Badge>
        )}
      </header>

      {isLoading && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      )}

      {isError && (
        <ErrorState
          title="Couldn't load projects"
          message={formatApiError(error)}
          onRetry={() => refetch()}
        />
      )}

      {!isLoading && !isError && projects && projects.length === 0 && (
        <EmptyState
          title="No projects yet"
          message="Projects you own or are a member of will appear here."
        />
      )}

      {!isLoading && !isError && projects && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => {
            const glyph = projectGlyph(p.id);
            return (
              <Link key={p.id} href={`/projects/${p.slug}`} className="block">
                <Card className="transition-shadow hover:shadow-md">
                  <div className="flex items-center gap-3 border-b border-line-subtle px-5 py-4">
                    <ProjectMark
                      tint={glyph.tint}
                      ink={glyph.ink}
                      initials={projectInitials(p.name)}
                      size={36}
                    />
                    <span className="fg-label flex-1 truncate">{p.name}</span>
                    <Badge tone={p.role === "owner" ? "accent" : "neutral"}>{p.role}</Badge>
                  </div>
                  <div className="flex items-center gap-4 px-5 py-4">
                    <Stat icon="folder" mono={false}>
                      {p.slug}
                    </Stat>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
