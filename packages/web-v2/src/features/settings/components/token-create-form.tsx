"use client";

// Create requires fresh auth (≤5 min); a 403 FRESH_AUTH_REQUIRED swaps the
// form for an inline re-auth prompt, then retries the pending create. Password
// users confirm inline via POST /api/auth/reauth; SSO-only users
// (passwordHash NULL) full-page-redirect through `:provider/reauth-start`.
import { type Dispatch, type SetStateAction, useState } from "react";
import {
  Button,
  Card,
  CardContent,
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
          toast({ title: "Couldn't create token", description: formatApiError(err), tone: "error" });
          return;
        }
        setNeedsReauth(true);
        toast({
          title: "Re-authenticate to continue",
          description: hasPassword
            ? "Confirm your password to create a token."
            : "Confirm with your sign-in provider to create a token.",
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
        toast({ title: "Re-authentication failed", description: formatApiError(err), tone: "error" }),
    });
  }

  function startSsoReauth(provider: string) {
    if (!buildInput()) return;
    stashDraft(draft);
    window.location.href = reauthStartUrl(provider, RETURN_PATH);
  }

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-4">Create a token</SectionTitle>
        <div className="space-y-4">
          <DraftFields draft={draft} setDraft={setDraft} errors={errors} menu={menu} />
          {needsReauth && hasPassword && (
            <Field label="Confirm password" required hint="Token creation requires a recent sign-in.">
              <Input
                type="password"
                value={password}
                autoComplete="current-password"
                placeholder="Your account password"
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
                  Confirm &amp; create
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
                Create token
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
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
  const projectOptions = [
    { value: "", label: "None — user-level / all my projects" },
    ...(projectsQ.data ?? []).map((p) => ({ value: p.id, label: `${p.name} (${p.slug})` })),
  ];

  return (
    <>
      <Field label="Name" required error={errors.name}>
        <Input
          value={draft.name}
          placeholder="e.g. CI deploy token"
          onChange={(e) => set("name", e.target.value)}
        />
      </Field>
      <Field label="Scopes" required error={errors.scopes} hint="What this token may do.">
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
        label="Permissions"
        required
        error={errors.permissions}
        hint="Which of the API this token reaches. Full access covers every permission, including any added later."
      >
        <RadioGroup
          name="pat-grant"
          value={draft.grantMode}
          onChange={(v) => set("grantMode", v as TokenDraft["grantMode"])}
        >
          <Radio value="full" label="Full access — every permission on the menu" />
          <Radio value="named" label="Only the permissions I pick" />
        </RadioGroup>
        {draft.grantMode === "named" && (
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {(menu?.permissions ?? []).map((permission) => (
              <Checkbox
                key={permission}
                checked={draft.permissions.includes(permission)}
                onChange={() =>
                  setDraft((d) => ({ ...d, permissions: toggled(d.permissions, permission) }))
                }
                label={permission}
              />
            ))}
          </div>
        )}
      </Field>
      <Field label="Expires" hint="Optional. Leave blank for a non-expiring token.">
        <Input type="date" value={draft.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} />
      </Field>
      <Field
        label="Bind to a project"
        hint={
          projectsQ.isLoading
            ? "Loading your projects…"
            : "Optional. A project-level token works only against the chosen project, and MCP clients can drop the X-Forge-Project-Slug header."
        }
      >
        <Select
          options={projectOptions}
          value={draft.boundProjectId}
          onChange={(v) => set("boundProjectId", v)}
          disabled={projectsQ.isLoading}
          placeholder={projectsQ.isLoading ? "Loading…" : "None — user-level"}
        />
      </Field>
    </>
  );
}

function SsoReauth({ providers, onStart }: { providers: string[]; onStart: (p: string) => void }) {
  return (
    <Field
      label="Re-authenticate"
      hint={
        providers.length > 0
          ? "Token creation requires a recent sign-in. Confirm with your sign-in provider — you'll come right back here with the form intact."
          : "Token creation requires a recent sign-in, but this account has no password and no linked sign-in provider. Ask an administrator for help."
      }
    >
      <div className="flex flex-wrap gap-3 pt-1">
        {providers.map((p) => (
          <Button key={p} variant="primary" onClick={() => onStart(p)} className="min-h-11">
            Continue with {PROVIDER_LABELS[p] ?? p}
          </Button>
        ))}
      </div>
    </Field>
  );
}
