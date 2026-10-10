"use client";

import { createContext, use } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/providers/toast-provider";
import { formatApiError } from "@/lib/api/error";
import { preferencesApi } from "@/features/preferences";
import { PREFERENCES_KEY as PREFS_KEY, usePreferences } from "@/features/preferences";
import type { Preferences } from "@/features/preferences";
import { useCopy } from "@/lib/i18n/interface-language";
import { useOrgs } from "./hooks";
import type { OrgListItem } from "./types";

/** Personal org first, then alphabetical by name — matches Settings → Orgs. */
function sortOrgs(orgs: OrgListItem[]): OrgListItem[] {
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
  const t = useCopy();
  const { data: orgsData } = useOrgs();
  const { data: prefs } = usePreferences();

  const orgs = sortOrgs(orgsData ?? []);

  const stored = prefs?.activeOrgId ?? null;
  const activeOrg =
    orgs.length === 0
      ? null
      : ((stored ? orgs.find((o) => o.id === stored) : undefined) ?? orgs.find((o) => o.isPersonal) ?? orgs[0]);

  const mutation = useMutation({
    mutationFn: (orgId: string) => preferencesApi.update({ activeOrgId: orgId }),
    // Optimistically flip the stored preference so the chrome + console update
    // instantly; reconcile/rollback against the server response.
    onMutate: (orgId: string) => {
      const prev = qc.getQueryData<Preferences>(PREFS_KEY);
      if (prev) qc.setQueryData<Preferences>(PREFS_KEY, { ...prev, activeOrgId: orgId });
      return { prev };
    },
    onError: (err, _orgId, ctx) => {
      if (ctx?.prev) qc.setQueryData(PREFS_KEY, ctx.prev);
      toast({ title: t("settings.orgs.switchFailed"), description: formatApiError(err), tone: "error" });
    },
    onSuccess: (data) => {
      qc.setQueryData(PREFS_KEY, data);
    },
  });

  const { mutate } = mutation;
  const value: ActiveOrgContextValue = {
    orgs,
    activeOrg,
    activeOrgId: activeOrg?.id ?? null,
    setActiveOrg: (orgId: string) => {
      if (orgId !== activeOrg?.id) mutate(orgId);
    },
    isSingle: orgs.length <= 1,
  };

  return <ActiveOrgContext value={value}>{children}</ActiveOrgContext>;
}

/** Read the active-org context. Returns a safe empty state if used outside the
 *  provider (e.g. an isolated test render) rather than throwing. */
export function useActiveOrg(): ActiveOrgContextValue {
  const ctx = use(ActiveOrgContext);
  if (ctx) return ctx;
  return { orgs: [], activeOrg: null, activeOrgId: null, setActiveOrg: () => {}, isSingle: true };
}
