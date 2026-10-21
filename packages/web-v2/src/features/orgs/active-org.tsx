"use client";

import { createContext, useContext, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { settingsApi } from "@/features/settings/api";
import type { Preferences } from "@/features/settings/types";
import { usePreferences } from "@/features/settings/hooks";
import { useOrgs } from "./hooks";
import type { OrgListItem } from "./types";
import { failureToast } from "@/lib/api/failure-toast";

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
  /** The resolved active org (null while the orgs or the stored preference are still being read). */
  activeOrg: OrgListItem | null;
  /** Convenience: `activeOrg?.id ?? null`. Drives the projects-console scope. */
  activeOrgId: string | null;
  /** The orgs and the stored choice have both been read, so a null `activeOrgId` means no org, not "not yet". */
  scopeRead: boolean;
  /** Why the orgs could not be read, where they could not: no scope is known, so nothing scoped is read. */
  scopeError: Error | null;
  retryScope: () => void;
  /** Switch the active org (persists server-side, optimistic): the org switcher's act, and only its. */
  setActiveOrg: (orgId: string) => void;
  /** Scope this tab's view to an org, as opening one of its projects does, writing nothing. */
  viewOrg: (orgId: string) => void;
  /** True when the caller has at most one org → render a static label. */
  isSingle: boolean;
}

const ActiveOrgContext = createContext<ActiveOrgContextValue | null>(null);

export function ActiveOrgProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const orgsQ = useOrgs();
  const orgsData = orgsQ.data;
  const prefsQ = usePreferences();
  const prefs = prefsQ.data;
  // No active org until the stored choice is read: a stand-in it replaced would read as a switch.
  const prefsRead = prefsQ.isSuccess || prefsQ.isError;
  const scopeRead = prefsRead && orgsQ.data !== undefined;
  const scopeError = orgsQ.data === undefined && orgsQ.isError ? orgsQ.error : null;
  const { refetch: refetchOrgs } = orgsQ;

  const orgs = useMemo(() => sortOrgs(orgsData ?? []), [orgsData]);
  // The org this tab is viewing where a visit chose one other than the stored choice; never stored.
  const [viewing, setViewing] = useState<string | null>(null);

  const activeOrg = useMemo(() => {
    if (orgs.length === 0 || !prefsRead) return null;
    const stored = prefs?.activeOrgId ?? null;
    return (
      (viewing ? orgs.find((o) => o.id === viewing) : undefined) ??
      (stored ? orgs.find((o) => o.id === stored) : undefined) ??
      orgs.find((o) => o.isPersonal) ??
      orgs[0]
    );
  }, [orgs, prefsRead, prefs?.activeOrgId, viewing]);

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
      toast(failureToast(err, "The organization was not switched"));
    },
    onSuccess: (data) => {
      qc.setQueryData(PREFS_KEY, data);
    },
  });

  const { mutate } = mutation;
  const value = useMemo<ActiveOrgContextValue>(
    () => ({
      orgs,
      activeOrg,
      activeOrgId: activeOrg?.id ?? null,
      scopeRead,
      scopeError,
      retryScope: () => {
        void refetchOrgs();
      },
      setActiveOrg: (orgId: string) => {
        setViewing(null);
        if (orgId !== (prefs?.activeOrgId ?? null)) mutate(orgId);
      },
      viewOrg: (orgId: string) => {
        if (orgId !== activeOrg?.id) setViewing(orgId);
      },
      isSingle: orgs.length <= 1,
    }),
    [orgs, activeOrg, scopeRead, scopeError, refetchOrgs, mutate, prefs?.activeOrgId],
  );

  return <ActiveOrgContext.Provider value={value}>{children}</ActiveOrgContext.Provider>;
}

/** Read the active-org context. Returns a safe empty state if used outside the
 *  provider (e.g. an isolated test render) rather than throwing. */
export function useActiveOrg(): ActiveOrgContextValue {
  const ctx = useContext(ActiveOrgContext);
  if (ctx) return ctx;
  return { orgs: [], activeOrg: null, activeOrgId: null,
    scopeRead: true,
    scopeError: null,
    retryScope: () => {},
    setActiveOrg: () => {},
    viewOrg: () => {},
    isSingle: true,
  };
}
