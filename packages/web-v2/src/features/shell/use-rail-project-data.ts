"use client";

import { useMemo } from "react";
import { inActiveOrg } from "@/features/projects/derive";
import { useProjectsConsole } from "@/features/projects/hooks";
import { projectGlyph, projectInitials } from "@/features/projects/glyph";
import type { ProjectListItem } from "@/features/projects/types";
import type { RailProject, SwitcherProject } from "./components/project-switcher";

/** The rail's project mark and the switcher's list, both from the projects console and scoped to the active org (ISS-480). */
export function useRailProjectData(opts: {
  /** The project the rail renders (active, else last-visited, else first). */
  railSlug: string | null;
  railProject: ProjectListItem | null;
  activeOrgId: string | null;
}) {
  const { railSlug, railProject, activeOrgId } = opts;
  const projectsConsole = useProjectsConsole();

  const switcherProjects = useMemo<SwitcherProject[]>(
    () =>
      projectsConsole.items
        .filter((p) => inActiveOrg(p, activeOrgId))
        .map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          initials: projectInitials(p.name),
          ...projectGlyph(p.id),
          liveRuns: p.liveRuns,
          pinned: p.pinned,
        })),
    [projectsConsole.items, activeOrgId],
  );

  const projectMark = useMemo<RailProject | null>(() => {
    if (!railProject) return null;
    const live = railSlug ? projectsConsole.items.find((p) => p.slug === railSlug)?.liveRuns : undefined;
    const { tint, ink } = projectGlyph(railProject.id);
    return { name: railProject.name, initials: projectInitials(railProject.name), tint, ink, liveRuns: live ?? 0 };
  }, [railProject, railSlug, projectsConsole.items]);

  return { projectMark, switcherProjects, togglePin: projectsConsole.toggle };
}
