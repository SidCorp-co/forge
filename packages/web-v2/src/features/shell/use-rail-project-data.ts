"use client";

// Rail project-context data: the glyph mark for the rail's switcher button and
// the compact-rail rollup (per-project liveRuns/openIssues from the projects
// console — the "{N} live" label, the switcher pulse dots, the Issues badge).
import { useMemo } from "react";
import { useProjectsConsole } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import type { ProjectListItem } from "@/features/projects/types";
import { openWorkFigure } from "./nav-model";
import type { SwitcherProject } from "./nav-rail-compact";

export function useRailProjectData(opts: {
  /** The project the rail renders (active, else last-visited, else first). */
  railSlug: string | null;
  railProject: ProjectListItem | null;
  /** Active org id — scopes the rail switcher list (ISS-480). */
  activeOrgId: string | null;
}) {
  const { railSlug, railProject, activeOrgId } = opts;

  // Project-tier glyph for the rail's switcher button — follows the rail project.
  const projectMark = useMemo(() => {
    if (!railProject) return undefined;
    const g = projectGlyph(railProject.id);
    return {
      name: railProject.name,
      initials: projectInitials(railProject.name),
      tint: g.tint,
      ink: g.ink,
    };
  }, [railProject]);

  const projectsConsole = useProjectsConsole();
  const switcherProjects = useMemo<SwitcherProject[]>(
    () =>
      projectsConsole.items
        // Scope the rail switcher to the active org (ISS-480).
        .filter((p) => !activeOrgId || p.orgId === activeOrgId)
        .map((p) => {
          const g = projectGlyph(p.id);
          return {
            id: p.id,
            slug: p.slug,
            name: p.name,
            initials: projectInitials(p.name),
            tint: g.tint,
            ink: g.ink,
            liveRuns: p.liveRuns,
            liveRunsRead: p.healthRead,
            pinned: p.pinned,
          };
        }),
    [projectsConsole.items, activeOrgId],
  );
  const railConsole = useMemo(
    () => (railSlug ? projectsConsole.items.find((p) => p.slug === railSlug) ?? null : null),
    [projectsConsole.items, railSlug],
  );
  // The Issues row's figure: the console's zero is a default until both reads are in.
  const { projectsRead, healthRead } = projectsConsole;
  const openWorkCount = railConsole?.openIssues ?? 0;
  const openWork = useMemo(
    () => openWorkFigure([projectsRead, healthRead], openWorkCount),
    [projectsRead, healthRead, openWorkCount],
  );
  const compactActiveProject = useMemo(
    () =>
      railProject && projectMark
        ? {
            name: projectMark.name,
            initials: projectMark.initials,
            tint: projectMark.tint,
            ink: projectMark.ink,
            liveRuns: railConsole ? railConsole.liveRuns : projectsConsole.healthRead === 'read' ? 0 : null,
            liveRunsRead: projectsConsole.healthRead,
          }
        : null,
    [railProject, projectMark, railConsole, projectsConsole.healthRead],
  );

  return {
    projectMark,
    switcherProjects,
    railConsole,
    openWork,
    compactActiveProject,
    /** Pin/unpin passthrough for the compact rail's switcher flyout. */
    togglePin: projectsConsole.toggle,
  };
}
