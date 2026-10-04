"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/providers/toast-provider";
import type { CreatePatInput, PatScope, PatToken } from "../types";

type GrantMode = "" | "full" | "named";

interface DraftFields {
  name: string;
  scopes: PatScope[];
  // ISS-1255 — the form picks no power on the minter's behalf. "" is "nothing
  // chosen yet", and it is what the create button is refused on.
  grantMode: GrantMode;
  permissions: string[];
  expiresAt: string;
  // ISS-497 — "" = None (user-level); a project id = bind the token to it.
  boundProjectId: string;
}

export type DraftErrors = { name?: string; scopes?: string; permissions?: string };

const EMPTY: DraftFields = {
  name: "",
  scopes: ["read"],
  grantMode: "",
  permissions: [],
  expiresAt: "",
  boundProjectId: "",
};

// Form draft persisted across the SSO reauth full-page redirect.
const DRAFT_KEY = "forge.settings.token-draft";

const REAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_not_linked: "Your account isn't linked to that provider.",
  identity_mismatch: "The provider account doesn't match the one linked to your Forge account.",
};

const toggled = <T,>(list: T[], item: T) =>
  list.includes(item) ? list.filter((x) => x !== item) : [...list, item];

/**
 * The create-token form's fields, their validation into a create call, and the
 * draft that survives an SSO reauth round-trip through sessionStorage.
 */
export function useTokenDraft(tokens: PatToken[], menu: { full: string } | null) {
  const [draft, setDraft] = useState<DraftFields>(EMPTY);
  const [errors, setErrors] = useState<DraftErrors>({});
  const set = <K extends keyof DraftFields>(key: K, value: DraftFields[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  useReauthReturn(setDraft);

  function buildInput(): CreatePatInput | null {
    const { name, scopes, grantMode, permissions, expiresAt, boundProjectId } = draft;
    const next: DraftErrors = {};
    if (!name.trim()) next.name = "Name is required.";
    else if (tokens.some((t) => t.name === name.trim() && !t.revokedAt))
      next.name = "An active token already uses this name.";
    if (scopes.length === 0) next.scopes = "Select at least one scope.";
    if (!grantMode) next.permissions = "Choose what this token may reach.";
    else if (grantMode === "named" && permissions.length === 0)
      next.permissions = "Pick at least one permission, or choose full access.";
    else if (!menu) next.permissions = "The permission menu hasn't loaded yet.";
    setErrors(next);
    if (Object.keys(next).length > 0 || !menu) return null;
    return {
      name: name.trim(),
      scopes,
      permissions: grantMode === "full" ? [menu.full] : permissions,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(boundProjectId ? { boundProjectId } : {}),
    };
  }

  return {
    draft,
    errors,
    set,
    toggleScope: (scope: PatScope) => set("scopes", toggled(draft.scopes, scope)),
    togglePermission: (p: string) => set("permissions", toggled(draft.permissions, p)),
    buildInput,
    reset: () => {
      setDraft(EMPTY);
      setErrors({});
    },
    stash: () => sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)),
  };
}

/**
 * Consume the SSO reauth outcome on return: restore the draft on success,
 * surface the typed error on failure, and strip the params either way so a
 * refresh doesn't replay the toast.
 */
function useReauthReturn(setDraft: (draft: DraftFields) => void) {
  const { toast } = useToast();
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const ok = sp.get("reauth") === "ok";
    const errCode = sp.get("reauth_error");
    if (!ok && !errCode) return;

    sp.delete("reauth");
    sp.delete("reauth_error");
    const qs = sp.toString();
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );

    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);

    if (ok) {
      if (raw) {
        try {
          const saved = JSON.parse(raw) as Partial<DraftFields>;
          setDraft({ ...EMPTY, ...saved, scopes: saved.scopes?.length ? saved.scopes : EMPTY.scopes });
        } catch {
          // corrupt draft — start clean
        }
      }
      toast({
        title: "Re-authenticated",
        description: "You're verified for the next few minutes — create your token now.",
        tone: "success",
      });
    } else if (errCode) {
      toast({
        title: "Re-authentication failed",
        description: REAUTH_ERROR_MESSAGES[errCode] ?? errCode,
        tone: "error",
      });
    }
  }, [toast, setDraft]);
}
