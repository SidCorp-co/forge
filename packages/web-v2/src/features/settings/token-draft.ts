"use client";

// The create-token form's draft, and its round-trip through the SSO re-auth
// redirect (ISS-167): the draft is stashed in sessionStorage before the
// full-page redirect, and the callback returns with `?reauth=ok` /
// `?reauth_error=<code>`, which `useSsoReauthReturn` consumes on mount.
import { useEffect } from "react";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useToast } from "@/providers/toast-provider";
import type { CreatePatInput, PatMenu, PatScope, PatToken } from "./types";

export interface TokenDraft {
  name: string;
  scopes: PatScope[];
  // ISS-1255 — the form picks no power on the minter's behalf. "" is "nothing
  // chosen yet", and it is what the create button is refused on.
  grantMode: "" | "full" | "named";
  permissions: string[];
  expiresAt: string;
  // ISS-497 — "" = None (user-level); a project id = bind the token to it.
  boundProjectId: string;
}

/** What is wrong with each field, as a copy key the form reads in the interface language. */
export type DraftErrors = { name?: ProductCopyKey; scopes?: ProductCopyKey; permissions?: ProductCopyKey };

export const EMPTY_DRAFT: TokenDraft = {
  name: "",
  scopes: ["read"],
  grantMode: "",
  permissions: [],
  expiresAt: "",
  boundProjectId: "",
};

const DRAFT_KEY = "forge.settings.token-draft";

const REAUTH_ERROR_MESSAGES: Record<string, ProductCopyKey> = {
  oauth_not_linked: "settings.tokens.reauth.notLinked",
  identity_mismatch: "settings.tokens.reauth.mismatch",
};

export function toggled<T>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export function validateDraft(
  draft: TokenDraft,
  tokens: PatToken[],
  menu: PatMenu | null,
): { errors: DraftErrors; input: CreatePatInput | null } {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  if (!name) errors.name = "settings.tokens.err.name";
  else if (tokens.some((t) => t.name === name && !t.revokedAt)) errors.name = "settings.tokens.err.nameTaken";
  if (draft.scopes.length === 0) errors.scopes = "settings.tokens.err.scopes";
  if (!draft.grantMode) errors.permissions = "settings.tokens.err.grant";
  else if (draft.grantMode === "named" && draft.permissions.length === 0) errors.permissions = "settings.tokens.err.permissions";
  else if (!menu) errors.permissions = "settings.tokens.err.menu";
  if (Object.keys(errors).length > 0 || !menu) return { errors, input: null };
  return {
    errors,
    input: {
      name,
      scopes: draft.scopes,
      permissions: draft.grantMode === "full" ? [menu.full] : draft.permissions,
      ...(draft.expiresAt ? { expiresAt: new Date(draft.expiresAt).toISOString() } : {}),
      ...(draft.boundProjectId ? { boundProjectId: draft.boundProjectId } : {}),
    },
  };
}

export function stashDraft(draft: TokenDraft) {
  sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

/** Restore the draft on success, surface the typed error on failure, and strip
 *  the params either way so a refresh doesn't replay the toast. */
/** `restore` must be stable (a state setter): the effect runs once per return. */
export function useSsoReauthReturn(restore: (draft: TokenDraft) => void) {
  const { toast } = useToast();
  const t = useCopy();
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

    if (errCode && !ok) {
      toast({
        title: t("settings.tokens.reauth.failed"),
        description: REAUTH_ERROR_MESSAGES[errCode] ? t(REAUTH_ERROR_MESSAGES[errCode]) : errCode,
        tone: "error",
      });
      return;
    }
    if (raw) {
      try {
        const saved = JSON.parse(raw) as Partial<TokenDraft>;
        restore({
          ...EMPTY_DRAFT,
          ...saved,
          scopes: saved.scopes?.length ? saved.scopes : EMPTY_DRAFT.scopes,
        });
      } catch {
        // corrupt draft — start clean
      }
    }
    toast({
      title: t("settings.tokens.reauth.done"),
      description: t("settings.tokens.reauth.doneBody"),
      tone: "success",
    });
  }, [toast, restore, t]);
}
