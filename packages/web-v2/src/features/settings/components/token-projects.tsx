"use client";

// FB-48 — a token's project list, edited in place: add or remove one project at a time, the secret
// kept. Each act is `PATCH /api/pat/:id` behind a fresh sign-in; a 403 FRESH_AUTH_REQUIRED asks for
// the password (or the sign-in provider) and then sends the same act again. Core records each change.
import { useState } from "react";
import { Button, Field, Input, Select } from "@/design";
import { isFreshAuthError } from "@/features/auth";
import { reauthStartUrl } from "@/features/auth";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useReauth, useSetTokenProjects } from "../hooks";
import type { PatToken } from "../types";
import { SsoReauth } from "./token-create-form";

interface ProjectRef {
  id: string;
  slug: string;
  name: string;
}

/** The projects a fenced token reaches: its bound project alone, else its list. */
export function fenceOf(token: PatToken): string[] | null {
  if (token.boundProjectId) return [token.boundProjectId];
  return token.projectIds;
}

export function TokenProjects({ token, projects }: { token: PatToken; projects: ProjectRef[] }) {
  const t = useCopy();
  const { toast } = useToast();
  const { user } = useAuth();
  const hasPassword = user?.hasPassword ?? true;
  const save = useSetTokenProjects();
  const reauth = useReauth();
  const [owed, setOwed] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [adding, setAdding] = useState("");
  const fence = owed ?? fenceOf(token) ?? [];
  const byId = new Map(projects.map((p) => [p.id, p]));
  const busy = save.isPending || reauth.isPending;

  function send(projectIds: string[]) {
    save.mutate(
      { id: token.id, projectIds },
      {
        onSuccess: () => {
          setOwed(null);
          setPassword("");
          setAdding("");
          toast({ title: t("settings.tokens.projectsSaved"), tone: "success" });
        },
        onError: (err) => {
          if (isFreshAuthError(err)) return setOwed(projectIds);
          toast({ title: t("settings.tokens.projectsFailed"), description: formatApiError(err), tone: "error" });
        },
      },
    );
  }

  function confirm() {
    if (!owed || !password) return;
    reauth.mutate(password, {
      onSuccess: () => send(owed),
      onError: (err) => toast({ title: t("settings.tokens.reauth.failed"), description: formatApiError(err), tone: "error" }),
    });
  }

  const addable = projects.filter((p) => !fence.includes(p.id)).map((p) => ({ value: p.id, label: p.slug }));
  return (
    <div className="space-y-5" data-testid="token-projects">
      <p className="fg-body-sm text-muted">{t("settings.tokens.projectsLead", { name: token.name })}</p>
      <ul className="divide-y divide-line border-y border-line">
        {fence.map((id) => (
          <li key={id} className="flex min-h-12 items-center gap-3 py-1.5">
            <span className="min-w-0 flex-1 truncate text-13 text-fg">{byId.get(id)?.slug ?? id.slice(0, 8)}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || owed !== null || fence.length === 1}
              title={fence.length === 1 ? t("settings.tokens.projectsLast") : undefined}
              onClick={() => send(fence.filter((p) => p !== id))}
              className="min-h-11"
            >
              {t("settings.tokens.projectRemove")}
            </Button>
          </li>
        ))}
      </ul>
      {owed === null && addable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-48 flex-1">
            <Select options={addable} value={adding} onChange={setAdding} placeholder={t("settings.tokens.projectPick")} aria-label={t("settings.tokens.projectPick")} />
          </div>
          <Button variant="secondary" icon="plus" disabled={!adding || busy} onClick={() => send([...fence, adding])} className="min-h-11">
            {t("settings.tokens.projectAdd")}
          </Button>
        </div>
      )}
      {owed !== null && hasPassword && (
        <div className="space-y-3">
          <Field label={t("settings.tokens.passwordLabel")} required hint={t("settings.tokens.projectsSignIn")}>
            <Input type="password" value={password} autoComplete="current-password" placeholder={t("settings.tokens.passwordPlaceholder")} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" loading={busy} disabled={!password} onClick={confirm} className="min-h-11">
              {t("settings.tokens.projectsConfirm")}
            </Button>
            <Button variant="secondary" onClick={() => setOwed(null)} className="min-h-11">
              {t("settings.tokens.projectsCancel")}
            </Button>
          </div>
        </div>
      )}
      {owed !== null && !hasPassword && (
        <SsoReauth providers={user?.oauthProviders ?? []} onStart={(p) => (window.location.href = reauthStartUrl(p, "/settings?tab=tokens"))} />
      )}
    </div>
  );
}
