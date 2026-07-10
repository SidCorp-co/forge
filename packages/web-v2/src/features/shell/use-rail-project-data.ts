"use client";

// Rail project-context data: the glyph mark for the rail's switcher button and
// the compact-rail rollup (per-project liveRuns/openIssues from the projects
// console — the "{N} live" label, the switcher pulse dots, the Issues badge).
import { useMemo } from "react";
import { useProjectsConsole } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import type { ProjectListItem } from "@/features/projects/types";
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
            pinned: p.pinned,
          };
        }),
    [projectsConsole.items, activeOrgId],
  );
  const railConsole = useMemo(
    () => (railSlug ? projectsConsole.items.find((p) => p.slug === railSlug) ?? null : null),
    [projectsConsole.items, railSlug],
  );
  const compactActiveProject = useMemo(
    () =>
      railProject && projectMark
        ? {
            name: projectMark.name,
            initials: projectMark.initials,
            tint: projectMark.tint,
            ink: projectMark.ink,
            liveRuns: railConsole?.liveRuns ?? 0,
          }
        : null,
    [railProject, projectMark, railConsole],
  );

  return {
    projectMark,
    switcherProjects,
    railConsole,
    compactActiveProject,
    /** Pin/unpin passthrough for the compact rail's switcher flyout. */
    togglePin: projectsConsole.toggle,
  };
}
