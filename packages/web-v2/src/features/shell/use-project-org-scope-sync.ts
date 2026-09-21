"use client";

// web-v2 shell feature module — keeps the active-org scope and the open
// project consistent (ISS-470 / ISS-476 / ISS-480). Owns the "last project
// visited" persisted slug too, since the ISS-480 leave-project path must drop
// it. The layout calls this once and consumes { activeOrgId, lastSlug }.
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useActiveOrg } from "@/features/orgs/active-org";
import type { ProjectListItem } from "@/features/projects/types";
import { usePerTabState } from "@/lib/utils/use-persisted-state";

export function useProjectOrgScopeSync(opts: {
  /** Active project slug from the pathname (null outside a project). */
  slug: string | null;
  /** The resolved active project row (null until `projects` loads / no match). */
  activeProject: ProjectListItem | null;
}): { activeOrgId: string | null; lastSlug: string | null } {
  const { slug, activeProject } = opts;
  const router = useRouter();

  const { orgs, activeOrgId, setActiveOrg } = useActiveOrg();
  const lastScopedSlugRef = useRef<string | null>(null);
  useEffect(() => {
    if (!slug) {
      lastScopedSlugRef.current = null;
      return;
    }
    const target = activeProject?.orgId;
    if (!target) return; // project row not resolved yet — don't mark as handled
    // `orgs` (useOrgs) and `projects` (useProjects) are independent parallel
    // queries with no ordering guarantee. If projects wins the cold-load race,
    // `orgs` is still [] and membership can't be decided yet — don't mark the
    // slug handled, so the effect retries once orgs arrives. Otherwise a
    // cross-org deep-link would skip the re-scope permanently (ISS-476 review).
    if (orgs.length === 0) return;
    if (slug === lastScopedSlugRef.current) return; // same project: don't fight a manual switch
    lastScopedSlugRef.current = slug;
    // Only re-scope to an org the caller actually belongs to (ISS-472: an org
    // outside `orgs` would resolve straight back and storm setActiveOrg).
    if (target !== activeOrgId && orgs.some((o) => o.id === target)) {
      setActiveOrg(target);
    }
  }, [slug, activeProject?.orgId, activeOrgId, orgs, setActiveOrg]);

  // Remember the last project visited so the rail can keep showing a project
  // context (mark + tier) even on workspace screens — no vanishing block.
  // Per-tab (ISS-731): each tab keeps its own last-visited project instead of
  // adopting whatever another open tab last wrote.
  const [lastSlug, setLastSlug] = usePerTabState<string | null>("web-v2:last-project", null);
  useEffect(() => {
    if (slug && slug !== lastSlug) setLastSlug(slug);
  }, [slug, lastSlug, setLastSlug]);

  const prevOrgRef = useRef(activeOrgId);
  useEffect(() => {
    const prevOrg = prevOrgRef.current;
    prevOrgRef.current = activeOrgId;
    if (prevOrg === activeOrgId) return; // org unchanged (incl. AC6 set-to-match)
    if (prevOrg == null) return; // initial null→org resolution is not a user switch — AC6 re-scope owns it (ISS-480 review)
    if (!slug || !activeProject) return; // not in a resolved project — fallback handles the rail
    if (activeProject.orgId === activeOrgId) return; // switched INTO the project's org → stay (AC2)
    // Switched to an org that does not own the open project → exit project context.
    setLastSlug(null); // drop the org-agnostic persisted slug so it can't resurrect
    router.push("/projects"); // org-scoped console; shows the empty state for 0-project orgs
  }, [activeOrgId, slug, activeProject, router, setLastSlug]);

  return { activeOrgId, lastSlug };
}
