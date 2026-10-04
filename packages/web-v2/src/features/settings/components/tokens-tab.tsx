"use client";

// Settings → API Tokens. List + create (one-time plaintext reveal) + revoke.
// Create/revoke require fresh auth (≤5 min); a 403 FRESH_AUTH_REQUIRED swaps the
// form for an inline re-auth prompt, then retries the pending create.
//
// Two re-auth paths, branched on `user.hasPassword`:
//   - password users confirm inline via POST /api/auth/reauth;
//   - SSO-only users (passwordHash NULL) full-page-redirect through
//     `:provider/reauth-start` (ISS-167). The form draft survives the redirect
//     via sessionStorage; the callback returns with `?reauth=ok` /
//     `?reauth_error=<code>` which this tab consumes on mount.
import { useState } from "react";
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
  SlideOver,
} from "@/design";
import { reauthStartUrl } from "@/features/auth/oauth-api";
import { isFreshAuthError } from "@/features/auth/fresh-auth";
import { useProjects } from "@/features/projects/hooks";
import { formatApiError } from "@/lib/api/error";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useCreateToken, useReauth, useTokens } from "../hooks";
import { type CreatePatInput, PAT_SCOPES, type PatToken, type PatTokenCreated } from "../types";
import { useTokenDraft } from "./token-draft";
import { TokenList } from "./token-list";

// Where the SSO reauth round-trip returns to (this tab).
const RETURN_PATH = "/settings?tab=tokens";

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  oidc: "SSO",
};

export function TokensTab() {
  const projectsQ = useProjects();
  const [revealed, setRevealed] = useState<PatTokenCreated | null>(null);

  const projects = projectsQ.data ?? [];
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  /** Human level label for a token row: "User-level" or "Project: <slug>". */
  function levelLabel(t: PatToken): string {
    if (!t.boundProjectId) return "User-level";
    return `Project: ${projectsById.get(t.boundProjectId)?.slug ?? t.boundProjectId.slice(0, 8)}`;
  }

  return (
    <div className="space-y-6">
      <CreateTokenCard projects={projects} projectsLoading={projectsQ.isLoading} onCreated={setRevealed} />
      <TokenList levelLabel={levelLabel} />
      <TokenReveal
        revealed={revealed}
        boundSlug={revealed?.boundProjectId ? projectsById.get(revealed.boundProjectId)?.slug : undefined}
        onClose={() => setRevealed(null)}
      />
    </div>
  );
}

type ProjectOption = { id: string; name: string; slug: string };

function CreateTokenCard({
  projects,
  projectsLoading,
  onCreated,
}: {
  projects: ProjectOption[];
  projectsLoading: boolean;
  onCreated: (token: PatTokenCreated) => void;
}) {
  const tokensQ = useTokens();
  const create = useCreateToken();
  const reauth = useReauth();
  const { toast } = useToast();
  const { user } = useAuth();

  // Default to the password prompt while /auth/me is still resolving — a
  // password user seeing it a beat early beats an SSO user seeing nothing.
  const hasPassword = user?.hasPassword ?? true;

  // The menu the door will accept, served beside the list so the form cannot
  // offer a name the create call would be refused for.
  const menu = tokensQ.data?.menu ?? null;
  const form = useTokenDraft(tokensQ.data?.tokens ?? [], menu);
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState("");

  /** Validate, stash the draft, and hand the browser to the provider. */
  function startSsoReauth(provider: string) {
    if (!form.buildInput()) return;
    form.stash();
    window.location.href = reauthStartUrl(provider, RETURN_PATH);
  }

  function runCreate(input: CreatePatInput) {
    create.mutate(input, {
      onSuccess: (token) => {
        onCreated(token);
        setNeedsReauth(false);
        setPassword("");
        form.reset();
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

  function onCreate() {
    const input = form.buildInput();
    if (input) runCreate(input);
  }

  function onConfirmReauth() {
    const input = form.buildInput();
    if (!input || !password) return;
    reauth.mutate(password, {
      onSuccess: () => runCreate(input),
      onError: (err) =>
        toast({ title: "Re-authentication failed", description: formatApiError(err), tone: "error" }),
    });
  }

  return (
    <Card>
      <CardContent>
        <SectionTitle className="fg-h3 mb-4">Create a token</SectionTitle>
        <div className="space-y-4">
          <TokenFields form={form} menu={menu} projects={projects} projectsLoading={projectsLoading} />
          {needsReauth && (
            <ReauthField
              hasPassword={hasPassword}
              providers={user?.oauthProviders ?? []}
              password={password}
              onPassword={setPassword}
              onProvider={startSsoReauth}
            />
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
              <Button variant="primary" icon="plus" loading={create.isPending} onClick={onCreate} className="min-h-11">
                Create token
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** A password confirm for a password account; the linked sign-in providers for an SSO-only one. */
function ReauthField({
  hasPassword,
  providers,
  password,
  onPassword,
  onProvider,
}: {
  hasPassword: boolean;
  providers: string[];
  password: string;
  onPassword: (value: string) => void;
  onProvider: (provider: string) => void;
}) {
  if (hasPassword) {
    return (
      <Field label="Confirm password" required hint="Token creation requires a recent sign-in.">
        <Input
          type="password"
          value={password}
          autoComplete="current-password"
          placeholder="Your account password"
          onChange={(e) => onPassword(e.target.value)}
        />
      </Field>
    );
  }
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
          <Button key={p} variant="primary" onClick={() => onProvider(p)} className="min-h-11">
            Continue with {PROVIDER_LABELS[p] ?? p}
          </Button>
        ))}
      </div>
    </Field>
  );
}

function TokenFields({
  form,
  menu,
  projects,
  projectsLoading,
}: {
  form: ReturnType<typeof useTokenDraft>;
  menu: { permissions: string[] } | null;
  projects: ProjectOption[];
  projectsLoading: boolean;
}) {
  const { draft, errors, set, toggleScope, togglePermission } = form;
  const projectOptions = [
    { value: "", label: "None — user-level / all my projects" },
    ...projects.map((p) => ({ value: p.id, label: `${p.name} (${p.slug})` })),
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
              onChange={() => toggleScope(scope)}
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
        <RadioGroup name="pat-grant" value={draft.grantMode} onChange={(v) => set("grantMode", v as "" | "full" | "named")}>
          <Radio value="full" label="Full access — every permission on the menu" />
          <Radio value="named" label="Only the permissions I pick" />
        </RadioGroup>
        {draft.grantMode === "named" && (
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {(menu?.permissions ?? []).map((permission) => (
              <Checkbox
                key={permission}
                checked={draft.permissions.includes(permission)}
                onChange={() => togglePermission(permission)}
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
          projectsLoading
            ? "Loading your projects…"
            : "Optional. A project-level token works only against the chosen project, and MCP clients can drop the X-Forge-Project-Slug header."
        }
      >
        <Select
          options={projectOptions}
          value={draft.boundProjectId}
          onChange={(v) => set("boundProjectId", v)}
          disabled={projectsLoading}
          placeholder={projectsLoading ? "Loading…" : "None — user-level"}
        />
      </Field>

    </>
  );
}

/** The one-time plaintext reveal after a create. */
function TokenReveal({
  revealed,
  boundSlug,
  onClose,
}: {
  revealed: PatTokenCreated | null;
  boundSlug: string | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  async function copyPlaintext() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      toast({ title: "Copied to clipboard", tone: "success" });
    } catch {
      toast({ title: "Copy failed", description: "Select and copy the token manually.", tone: "error" });
    }
  }
  return (
    <SlideOver open={!!revealed} onClose={onClose} title="Token created">
      {revealed && (
        <div className="space-y-4">
          <p className="fg-body-sm text-muted">
            Copy this token now — it won&apos;t be shown again.
          </p>
          {revealed.boundProjectId && (
            <p className="fg-body-sm text-muted">
              This is a project-level token bound to{" "}
              <span className="font-medium text-fg">
                {boundSlug ?? "the selected project"}
              </span>
              . MCP clients can omit the <code className="font-mono">X-Forge-Project-Slug</code>{" "}
              header — calls resolve to this project automatically.
            </p>
          )}
          <div className="rounded-md border border-line bg-sunken p-3">
            <code className="block break-all font-mono text-13 text-fg">
              {revealed.plaintext}
            </code>
          </div>
          <div className="flex gap-3">
            <Button variant="primary" icon="check" onClick={copyPlaintext} className="min-h-11">
              Copy to clipboard
            </Button>
            <Button variant="secondary" onClick={onClose} className="min-h-11">
              Done
            </Button>
          </div>
        </div>
      )}
    </SlideOver>
  );
}
