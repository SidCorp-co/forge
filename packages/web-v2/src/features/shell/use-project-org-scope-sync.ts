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

  // Cross-org navigation consistency (ISS-470, AC6): OPENING a project that
  // belongs to a different org re-scopes the workspace to that project's org,
  // so the chrome label + console never lie about where you are. setActiveOrg
  // self-guards on no-op and persists via /me/preferences.
  //
  // CRITICAL (ISS-476): this must fire ONLY when the open project actually
  // CHANGES — not on every divergence between the project's org and activeOrgId.
  // A continuous reconcile makes the rail's org switcher dead while a project is
  // open: a deliberate manual switch flips activeOrgId, the effect sees it differ
  // from the (unchanged) open project's org, and snaps it straight back. We track
  // the last slug we re-scoped for so a manual switch on the SAME project sticks;
  // leaving the project (slug → null) resets it so re-entering re-scopes again.
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

  // Leave project context on a MANUAL cross-org switch (ISS-480). When the rail
  // switcher flips the active org to one that does NOT own the open project, the
  // workspace must stop showing the old org's project — otherwise the rail lies
  // (ORGANIZATION = new org, PROJECT = old org's project). We gate on the
  // PREVIOUS org so this never collides with the ISS-470 AC6 follow-on-open flow,
  // which ends with activeOrgId === the just-opened project's org:
  //   • Open cross-org project: slug changes first with org unchanged → the
  //     `prevOrg === activeOrgId` guard early-returns; the follow-effect then
  //     sets org = project.orgId → this re-runs but now project.orgId ===
  //     activeOrgId → early-returns. Never leaves.
  //   • Manual switch away: org transitions while slug is stable and the project
  //     is foreign → leave once.
  // No setActiveOrg here, so ISS-476 stays intact (no extra PATCH, no revert,
  // no React #185).
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
