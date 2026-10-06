"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { PageContainer, PageTitle } from "@/design";
import { ProjectGate } from "@/features/projects/components/project-gate";
import type { ProjectListItem } from "@/features/projects/types";
import { cn } from "@/lib/utils/cn";
import { ecosystemRoutes } from "../routes";

type Section = "channel" | "api";

// Threads is the workspace inbox, so its tab leaves the project; Project API is this project's own page, and its contracts live under Development
const SECTIONS: { value: Section; label: string; href: (slug: string) => string }[] = [
  { value: "channel", label: "Threads", href: () => ecosystemRoutes.threads() },
  { value: "api", label: "Project API", href: (s) => ecosystemRoutes.apiPage(s) },
];

/**
 * Resolves the route's project through ProjectGate, then frames an ecosystem page:
 * its title, and the ecosystem sections as links so each is reachable from the others.
 */
export function EcosystemPage({
  section,
  title,
  actions,
  children,
}: {
  section: Section;
  title: string;
  actions?: (project: ProjectListItem) => ReactNode;
  children: (project: ProjectListItem) => ReactNode;
}) {
  return (
    <ProjectGate label="loading…">
      {(project) => (
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
      )}
    </ProjectGate>
  );
}
