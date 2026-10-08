"use client";

// Create requires fresh auth (≤5 min); a 403 FRESH_AUTH_REQUIRED swaps the
// form for an inline re-auth prompt, then retries the pending create. Password
// users confirm inline via POST /api/auth/reauth; SSO-only users
// (passwordHash NULL) full-page-redirect through `:provider/reauth-start`.
import { type Dispatch, type SetStateAction, useState } from "react";
import {
  Button,
  PageSection,
  PageSectionBody,
  Checkbox,
  Field,
  Input,
  Radio,
  RadioGroup,
  SectionTitle,
  Select,
} from "@/design";
import { isFreshAuthError } from "@/features/auth/fresh-auth";
import { reauthStartUrl } from "@/features/auth/oauth-api";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useCreateToken, useReauth } from "../hooks";
import {
  type DraftErrors,
  EMPTY_DRAFT,
  stashDraft,
  type TokenDraft,
  toggled,
  useSsoReauthReturn,
  validateDraft,
} from "../token-draft";
import {
  type CreatePatInput,
  PAT_SCOPES,
  type PatMenu,
  type PatToken,
  type PatTokenCreated,
} from "../types";

const RETURN_PATH = "/settings?tab=tokens";

// a sign-in provider's own name, which no language changes
const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  oidc: "SSO",
};

export function TokenCreateForm({
  tokens,
  menu,
  onCreated,
}: {
  tokens: PatToken[];
  menu: PatMenu | null;
  onCreated: (token: PatTokenCreated) => void;
}) {
  const create = useCreateToken();
  const reauth = useReauth();
  const { toast } = useToast();
  const { user } = useAuth();
  // Default to the password prompt while /auth/me is still resolving — a
  // password user seeing it a beat early beats an SSO user seeing nothing.
  const hasPassword = user?.hasPassword ?? true;
  const t = useCopy();

  const [draft, setDraft] = useState<TokenDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState("");
  useSsoReauthReturn(setDraft);

  function buildInput(): CreatePatInput | null {
    const { errors: next, input } = validateDraft(draft, tokens, menu);
    setErrors(next);
    return input;
  }

  function runCreate(input: CreatePatInput) {
    create.mutate(input, {
      onSuccess: (token) => {
        onCreated(token);
        setNeedsReauth(false);
        setPassword("");
        setDraft(EMPTY_DRAFT);
        setErrors({});
      },
      onError: (err) => {
        if (!isFreshAuthError(err)) {
          toast({ title: t("settings.tokens.createFailed"), description: formatApiError(err), tone: "error" });
          return;
        }
        setNeedsReauth(true);
        toast({
          title: t("settings.tokens.reauthToContinue"),
          description: hasPassword ? t("settings.tokens.confirmPassword") : t("settings.tokens.confirmProvider"),
          tone: "info",
        });
      },
    });
  }

  function onConfirmReauth() {
    const input = buildInput();
    if (!input || !password) return;
    reauth.mutate(password, {
      onSuccess: () => runCreate(input),
      onError: (err) =>
        toast({ title: t("settings.tokens.reauth.failed"), description: formatApiError(err), tone: "error" }),
    });
  }

  function startSsoReauth(provider: string) {
    if (!buildInput()) return;
    stashDraft(draft);
    window.location.href = reauthStartUrl(provider, RETURN_PATH);
  }

  return (
    <PageSection>
      <PageSectionBody>
        <SectionTitle className="fg-h3 mb-4">{t("settings.tokens.createTitle")}</SectionTitle>
        <div className="space-y-4">
          <DraftFields draft={draft} setDraft={setDraft} errors={errors} menu={menu} />
          {needsReauth && hasPassword && (
            <Field label={t("settings.tokens.passwordLabel")} required hint={t("settings.tokens.recentSignIn")}>
              <Input
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder={t("settings.tokens.passwordPlaceholder")}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          )}
          {needsReauth && !hasPassword && (
            <SsoReauth providers={user?.oauthProviders ?? []} onStart={startSsoReauth} />
          )}
          <div className="flex flex-wrap gap-3">
            {needsReauth ? (
              hasPassword && (
                <Button
                  variant="primary"
                  loading={reauth.isPending || create.isPending}
                  disabled={!password}
                  onClick={onConfirmReauth}
                  className="min-h-11"
                >
                  {t("settings.tokens.confirmCreate")}
                </Button>
              )
            ) : (
              <Button
                variant="primary"
                icon="plus"
                loading={create.isPending}
                onClick={() => {
                  const input = buildInput();
                  if (input) runCreate(input);
                }}
                className="min-h-11"
              >
                {t("settings.tokens.create")}
              </Button>
            )}
          </div>
        </div>
      </PageSectionBody>
    </PageSection>
  );
}

function DraftFields({
  draft,
  setDraft,
  errors,
  menu,
}: {
  draft: TokenDraft;
  setDraft: Dispatch<SetStateAction<TokenDraft>>;
  errors: DraftErrors;
  menu: PatMenu | null;
}) {
  const projectsQ = useProjects();
  const set = <K extends keyof TokenDraft>(key: K, value: TokenDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const t = useCopy();
  const err = (key: ProductCopyKey | undefined) => (key ? t(key) : undefined);
  const projectOptions = [
    { value: "", label: t("settings.tokens.noneAll") },
    ...(projectsQ.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.slug})` })),
  ];

  return (
    <>
      <Field label={t("settings.agents.name")} required error={err(errors.name)}>
        <Input
          value={draft.name}
          placeholder={t("settings.tokens.namePlaceholder")}
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <Field label={t("settings.tokens.scopes")} required error={err(errors.scopes)} hint={t("settings.tokens.scopesHint")}>
        <div className="flex flex-wrap gap-4 pt-1">
          {PAT_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              checked={draft.scopes.includes(scope)}
              onChange={() => setDraft((d) => ({ ...d, scopes: toggled(d.scopes, scope) }))}
              label={scope}
            />
          ))}
        </div>
      </Field>
      <Field
        label={t("settings.tokens.permissionsLabel")}
        required
        error={err(errors.permissions)}
        hint={t("settings.tokens.permissionsHint")}
      >
        <RadioGroup
          name="pat-grant"
          value={draft.grantMode}
          onChange={(v) => set("grantMode", v as TokenDraft["grantMode"])}
        >
          <Radio value="full" label={t("settings.tokens.fullAll")} />
          <Radio value="named" label={t("settings.tokens.named")} />
        </RadioGroup>
        {draft.grantMode === "named" && (
          <>
            <PermissionPicks names={menu?.permissions ?? []} draft={draft} setDraft={setDraft} />
            <p className="fg-body-sm text-muted mt-4">{t("settings.tokens.explicitLabel")}</p>
            <PermissionPicks names={menu?.explicit ?? []} draft={draft} setDraft={setDraft} />
          </>
        )}
      </Field>
      <Field label={t("settings.tokens.expires")} hint={t("settings.tokens.expiresHint")}>
        <Input type="date" value={draft.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} />
      </Field>
      <Field
        label={t("settings.tokens.bind")}
        hint={projectsQ.isLoading ? t("settings.tokens.loadingProjects") : t("settings.tokens.bindHint")}
      >
        <Select
          options={projectOptions}
          value={draft.boundProjectId}
          onChange={(v) => set("boundProjectId", v)}
          disabled={projectsQ.isLoading}
          placeholder={projectsQ.isLoading ? t("integrations.provider.loading") : t("settings.tokens.noneUser")}
        />
      </Field>
    </>
  );
}

/** One checkbox per permission name; a pick toggles it in the draft's named grant. */
function PermissionPicks({
  names,
  draft,
  setDraft,
}: {
  names: string[];
  draft: TokenDraft;
  setDraft: Dispatch<SetStateAction<TokenDraft>>;
}) {
  return (
    <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      {names.map((permission) => (
        <Checkbox
          key={permission}
          checked={draft.permissions.includes(permission)}
          onChange={() => setDraft((d) => ({ ...d, permissions: toggled(d.permissions, permission) }))}
          label={permission}
        />
      ))}
    </div>
  );
}

function SsoReauth({ providers, onStart }: { providers: string[]; onStart: (p: string) => void }) {
  const t = useCopy();
  return (
    <Field
      label={t("settings.tokens.reauth")}
      hint={providers.length > 0 ? t("settings.tokens.reauthHint") : t("settings.tokens.reauthNone")}
    >
      <div className="flex flex-wrap gap-3 pt-1">
        {providers.map((p) => (
          <Button key={p} variant="primary" onClick={() => onStart(p)} className="min-h-11">
            {t("settings.tokens.continueWith", { provider: PROVIDER_LABELS[p] ?? p })}
          </Button>
        ))}
      </div>
    </Field>
  );
}
