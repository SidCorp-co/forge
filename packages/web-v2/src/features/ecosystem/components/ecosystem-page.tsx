"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ErrorState, PageContainer, PageTitle, ProjectLoader } from "@/design";
import { useProjects } from "@/features/projects/hooks";
import type { ProjectListItem } from "@/features/projects/types";
import { formatApiError } from "@/lib/api/error";
import { cn } from "@/lib/utils/cn";
import { ecosystemRoutes } from "../routes";

export type Section = "channel" | "contracts" | "api";

const SECTIONS: { value: Section; label: string; href: (slug: string) => string }[] = [
  { value: "channel", label: "Channel", href: (s) => ecosystemRoutes.register(s) },
  { value: "contracts", label: "Contracts", href: (s) => ecosystemRoutes.contracts(s) },
  { value: "api", label: "Project API", href: (s) => ecosystemRoutes.apiPage(s) },
];

/**
 * Resolves the route's project slug the way the issues pages do, then frames an ecosystem page:
 * its title, and the three ecosystem sections as links so each is reachable from the others.
 */
export function EcosystemPage({
  slug,
  section,
  title,
  actions,
  children,
}: {
  slug: string | undefined;
  section: Section;
  title: string;
  actions?: (project: ProjectListItem) => ReactNode;
  children: (project: ProjectListItem) => ReactNode;
}) {
  const { data: projects, isLoading, isError, error, refetch } = useProjects();
  if (isLoading) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ProjectLoader label="loading…" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState message={formatApiError(error)} onRetry={() => refetch()} />
      </div>
    );
  }
  const project = projects?.find((p) => p.slug === slug);
  if (!project) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <ErrorState
          title="Project not found"
          message="This project doesn't exist or you don't have access to it."
        />
      </div>
    );
  }
  return (
    <PageContainer className="min-w-0 space-y-4">
      <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="fg-caption">{project.slug} · Ecosystem</p>
          <PageTitle className="fg-h2 break-words">{title}</PageTitle>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions(project)}</div> : null}
      </header>
      <nav aria-label="Ecosystem sections" className="flex flex-wrap gap-1 border-b border-line">
        {SECTIONS.map((s) => (
          <Link
            key={s.value}
            href={s.href(project.slug)}
            aria-current={s.value === section ? "page" : undefined}
            className={cn(
              "px-3 py-2 text-13-5 font-semibold",
              s.value === section ? "text-fg" : "text-muted hover:text-fg",
            )}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      {children(project)}
    </PageContainer>
  );
}
