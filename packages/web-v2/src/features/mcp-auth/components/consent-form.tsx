// The question an MCP client's sign-in asks the person: who is asking, where the answer goes, and
// which reach to give it. Allowing needs a sign-in from the last few minutes, as minting a token
// does: a password person confirms it here, an SSO person goes round their provider and comes back
// to this page with the picks they made (`stashDraft`).
import type { McpConsentView } from "@forge/contracts/mcp-auth";
import { type Dispatch, type SetStateAction, useState } from "react";
import { Banner, Button, Checkbox, Field, Input, Radio, RadioGroup } from "@/design";
import { isFreshAuthError, reauthStartUrl } from "@/features/auth";
import { useProjects } from "@/features/projects";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useAuth } from "@/providers/auth-provider";
import {
  allowDecision,
  type ConsentDraft,
  type ConsentErrors,
  type ConsentRequest,
  denyDecision,
  draftFor,
  offeredPermissions,
  toggled,
} from "../consent-draft";
import { stashDraft, takeStashedDraft } from "../draft-stash";
import { useConsentDecision, usePasswordReauth } from "../hooks";

// a sign-in provider's own name, which no language changes
const PROVIDER_LABELS: Record<string, string> = { github: "GitHub", google: "Google", oidc: "SSO" };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function ConsentForm({
  view,
  request,
  returnPath,
}: {
  view: McpConsentView;
  request: ConsentRequest;
  /** This page's own path and query, which an SSO re-auth comes back to. */
  returnPath: string;
}) {
  const t = useCopy();
  // the picks made before an SSO re-auth left the page come back with it, once
  const [draft, setDraft] = useState<ConsentDraft>(() => takeStashedDraft(request) ?? draftFor(view));
  const { user } = useAuth();
  const hasPassword = user?.hasPassword ?? true;
  const [errors, setErrors] = useState<ConsentErrors>({});
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState("");
  const decide = useConsentDecision();
  const reauth = usePasswordReauth();
  const send = (decision: Record<string, unknown>) =>
    decide.mutate(decision, {
      onError: (err) => {
        if (isFreshAuthError(err)) setNeedsReauth(true);
      },
    });

  function allow() {
    const { errors: next, decision } = allowDecision(draft, view, request);
    setErrors(next);
    if (!decision) return;
    if (needsReauth && hasPassword) {
      reauth.mutate(password, { onSuccess: () => send(decision) });
      return;
    }
    send(decision);
  }

  function startSsoReauth(provider: string) {
    stashDraft(request, draft);
    window.location.href = reauthStartUrl(provider, returnPath);
  }

  const host = view.client.redirectHost;
  const failed = decide.isError && !isFreshAuthError(decide.error) ? decide.error : reauth.error;
  const err = (key: ProductCopyKey | undefined) => (key ? t(key) : undefined);
  const sent = decide.isSuccess;

  return (
    <div className="space-y-5">
      <div className="space-y-2 border-y border-line-subtle py-3">
        <p className="font-semibold text-fg">{t("auth.mcpConsent.asks", { name: view.client.name })}</p>
        <p className="fg-body-sm text-muted">
          {LOOPBACK.has(host.replace(/:\d+$/, ""))
            ? t("auth.mcpConsent.returnsHere", { host })
            : t("auth.mcpConsent.returnsTo", { host })}
        </p>
        {user ? <p className="fg-body-sm text-muted">{t("auth.linkChat.signedInAs", { email: user.email })}</p> : null}
      </div>

      <ReachFields view={view} draft={draft} setDraft={setDraft} errors={errors} err={err} />

      {needsReauth && hasPassword ? (
        <Field label={t("settings.tokens.passwordLabel")} required hint={t("auth.mcpConsent.recentSignIn")}>
          <Input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      ) : null}
      {needsReauth && !hasPassword ? (
        <Field label={t("settings.tokens.reauth")} hint={t("auth.mcpConsent.recentSignIn")}>
          <div className="flex flex-wrap gap-3 pt-1">
            {(user?.oauthProviders ?? []).map((p) => (
              <Button key={p} variant="primary" onClick={() => startSsoReauth(p)} className="min-h-11">
                {t("settings.tokens.continueWith", { provider: PROVIDER_LABELS[p] ?? p })}
              </Button>
            ))}
          </div>
        </Field>
      ) : null}

      {failed ? <Banner tone="danger">{formatApiError(failed)}</Banner> : null}
      {sent ? <Banner tone="success">{t("auth.mcpConsent.returning", { name: view.client.name })}</Banner> : null}

      <div className="flex flex-wrap gap-3">
        <Button
          variant="primary"
          className="min-h-11 flex-1"
          loading={decide.isPending || reauth.isPending}
          disabled={sent || (needsReauth && hasPassword && !password)}
          onClick={allow}
        >
          {t("auth.mcpConsent.allow")}
        </Button>
        <Button
          variant="secondary"
          className="min-h-11 flex-1"
          disabled={sent || decide.isPending}
          onClick={() => send(denyDecision(request))}
        >
          {t("auth.mcpConsent.deny")}
        </Button>
      </div>
    </div>
  );
}

/** Which projects, which permissions and which scopes the grant holds. */
function ReachFields({
  view,
  draft,
  setDraft,
  errors,
  err,
}: {
  view: McpConsentView;
  draft: ConsentDraft;
  setDraft: Dispatch<SetStateAction<ConsentDraft>>;
  errors: ConsentErrors;
  err: (key: ProductCopyKey | undefined) => string | undefined;
}) {
  const t = useCopy();
  const projectsQ = useProjects();
  const set = <K extends keyof ConsentDraft>(key: K, value: ConsentDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const offered = offeredPermissions(view, draft.reach);

  return (
    <>
      <Field label={t("auth.mcpConsent.projects")} required error={err(errors.reach)}>
        <RadioGroup name="mcp-reach" value={draft.reach} onChange={(v) => set("reach", v as ConsentDraft["reach"])}>
          <Radio value="all" label={t("auth.mcpConsent.allProjects")} />
          <Radio value="chosen" label={t("auth.mcpConsent.chosenProjects")} />
        </RadioGroup>
        {draft.reach === "chosen" ? (
          <div className="mt-3 grid grid-cols-1 gap-2.5">
            {(projectsQ.data ?? []).map((p) => (
              <Checkbox
                key={p.id}
                checked={draft.projectIds.includes(p.id)}
                onChange={() => setDraft((d) => ({ ...d, projectIds: toggled(d.projectIds, p.id) }))}
                label={p.name}
              />
            ))}
          </div>
        ) : null}
      </Field>
      <Field label={t("settings.tokens.permissionsLabel")} required error={err(errors.permissions)}>
        <RadioGroup name="mcp-grant" value={draft.grantMode} onChange={(v) => set("grantMode", v as ConsentDraft["grantMode"])}>
          <Radio value="full" label={t("settings.tokens.fullAll")} />
          <Radio value="named" label={t("settings.tokens.named")} />
        </RadioGroup>
        {draft.grantMode === "named" ? (
          <div className="mt-3 grid grid-cols-1 gap-2.5">
            {offered.map((permission) => (
              <Checkbox
                key={permission}
                checked={draft.permissions.includes(permission)}
                onChange={() => setDraft((d) => ({ ...d, permissions: toggled(d.permissions, permission) }))}
                label={permission}
              />
            ))}
          </div>
        ) : null}
      </Field>
      <Field label={t("settings.tokens.scopes")} required error={err(errors.scopes)}>
        <div className="flex flex-wrap gap-4 pt-1">
          {view.requestedScopes.map((scope) => (
            <Checkbox
              key={scope}
              checked={draft.scopes.includes(scope)}
              onChange={() => setDraft((d) => ({ ...d, scopes: toggled(d.scopes, scope) }))}
              label={scope}
            />
          ))}
        </div>
      </Field>
    </>
  );
}
