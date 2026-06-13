"use client";

// Active-org context (ISS-469) — the single source of truth for "which org am
// I working in". Sourced from useOrgs() (full membership, incl. empty orgs) and
// the server-side preference (user_preferences.active_org_id via /me/preferences).
// The chrome switcher reads `activeOrg`/`orgs` and calls `setActiveOrg`; the
// projects console scopes itself to `activeOrgId`.
import { createContext, useContext, useMemo } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { settingsApi } from "@/features/settings/api";
import type { Preferences } from "@/features/settings/types";
import { usePreferences } from "@/features/settings/hooks";
import { useOrgs } from "./hooks";
import type { OrgListItem } from "./types";

const PREFS_KEY = ["settings", "preferences"] as const;

/** Personal org first, then alphabetical by name — matches Settings → Orgs. */
export function sortOrgs(orgs: OrgListItem[]): OrgListItem[] {
  return [...orgs].sort(
    (a, b) => Number(b.isPersonal) - Number(a.isPersonal) || a.name.localeCompare(b.name),
  );
}

interface ActiveOrgContextValue {
  /** All orgs the caller belongs to, personal-first then alphabetical. */
  orgs: OrgListItem[];
  /** The resolved active org (null only while orgs are still loading). */
  activeOrg: OrgListItem | null;
  /** Convenience: `activeOrg?.id ?? null`. Drives the projects-console scope. */
  activeOrgId: string | null;
  /** Switch the active org (persists server-side, optimistic). */
  setActiveOrg: (orgId: string) => void;
  /** True when the caller has at most one org → render a static label. */
  isSingle: boolean;
}

const ActiveOrgContext = createContext<ActiveOrgContextValue | null>(null);

export function ActiveOrgProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: orgsData } = useOrgs();
  const { data: prefs } = usePreferences();

  const orgs = useMemo(() => sortOrgs(orgsData ?? []), [orgsData]);

  // Resolve the active org: the stored preference when it still points at an
  // org the caller belongs to, otherwise the personal org, otherwise the first.
  // This gracefully handles null (no choice yet) and stale ids (membership
  // removed after it was set).
  const activeOrg = useMemo(() => {
    if (orgs.length === 0) return null;
    const stored = prefs?.activeOrgId ?? null;
    return (
      (stored ? orgs.find((o) => o.id === stored) : undefined) ??
      orgs.find((o) => o.isPersonal) ??
      orgs[0]
    );
  }, [orgs, prefs?.activeOrgId]);

  const mutation = useMutation({
    mutationFn: (orgId: string) => settingsApi.updatePreferences({ activeOrgId: orgId }),
    // Optimistically flip the stored preference so the chrome + console update
    // instantly; reconcile/rollback against the server response.
    onMutate: (orgId: string) => {
      const prev = qc.getQueryData<Preferences>(PREFS_KEY);
      if (prev) qc.setQueryData<Preferences>(PREFS_KEY, { ...prev, activeOrgId: orgId });
      return { prev };
    },
    onError: (err, _orgId, ctx) => {
      if (ctx?.prev) qc.setQueryData(PREFS_KEY, ctx.prev);
      toast({ title: "Couldn't switch organization", description: formatApiError(err), tone: "error" });
    },
    onSuccess: (data) => {
      qc.setQueryData(PREFS_KEY, data);
    },
  });

  // React Query's `mutate` is referentially stable across renders; the wrapping
  // `mutation` object is NOT (new identity every render). Depend on `mutate`
  // alone so the context value (and `setActiveOrg`) only changes identity when
  // `orgs`/`activeOrg` change — otherwise consumers' effects keyed on
  // `setActiveOrg` re-run every render and can storm React #185 (ISS-472).
  const { mutate } = mutation;
  const value = useMemo<ActiveOrgContextValue>(
    () => ({
      orgs,
      activeOrg,
      activeOrgId: activeOrg?.id ?? null,
      setActiveOrg: (orgId: string) => {
        if (orgId !== activeOrg?.id) mutate(orgId);
      },
      isSingle: orgs.length <= 1,
    }),
    [orgs, activeOrg, mutate],
  );

  return <ActiveOrgContext.Provider value={value}>{children}</ActiveOrgContext.Provider>;
}

/** Read the active-org context. Returns a safe empty state if used outside the
 *  provider (e.g. an isolated test render) rather than throwing. */
export function useActiveOrg(): ActiveOrgContextValue {
  const ctx = useContext(ActiveOrgContext);
  if (ctx) return ctx;
  return { orgs: [], activeOrg: null, activeOrgId: null, setActiveOrg: () => {}, isSingle: true };
}
