"use client";

// Settings → API Tokens. The list comes first (what can still reach the account), then create
// (one-time plaintext reveal); revoke is on a live row.
// Create/revoke require fresh auth (≤5 min); a 403 FRESH_AUTH_REQUIRED swaps the
// form for an inline re-auth prompt, then retries the pending create.
//
// Two re-auth paths, branched on `user.hasPassword`:
//   - password users confirm inline via POST /api/auth/reauth;
//   - SSO-only users (passwordHash NULL) full-page-redirect through
//     `:provider/reauth-start` (ISS-167). The form draft survives the redirect
//     via sessionStorage; the callback returns with `?reauth=ok` /
//     `?reauth_error=<code>` which this tab consumes on mount.
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  ErrorState,
  Field,
  Input,
  Radio,
  RadioGroup,
  SectionTitle,
  Select,
  Skeleton,
  SlideOver,
} from "@/design";
import { reauthStartUrl } from "@/features/auth/oauth-api";
import { useProjects } from "@/features/projects/hooks";
import { isFreshAuthError } from "@/features/auth/fresh-auth";
import { formatApiError } from "@/lib/api/error";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useCreateToken, useReauth, useRevokeToken, useTokens } from "../hooks";
import {
  PAT_NAME_IN_USE,
  PAT_SCOPES,
  type CreatePatInput,
  type PatScope,
  type PatToken,
  type PatTokenCreated,
} from "../types";
import { TokenList } from "./token-list";

// Where the SSO reauth round-trip returns to (this tab).
const RETURN_PATH = "/settings?tab=tokens";

// Form draft persisted across the SSO reauth full-page redirect.
const DRAFT_KEY = "forge.settings.token-draft";
/** The form's own notices share one slot, dismissed when the Token created panel replaces the form. */
const FORM_NOTICE = "token-form";

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  oidc: "SSO",
};

const REAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_not_linked: "Your account isn't linked to that provider.",
  identity_mismatch: "The provider account doesn't match the one linked to your Forge account.",
};

interface FormErrors {
  name?: string;
  scopes?: string;
  permissions?: string;
}
type FormField = keyof FormErrors;
/** The fields in the order the form draws them, so the first refused is the one nearest the top. */
const FIELD_ORDER: FormField[] = ["name", "scopes", "permissions"];

interface FormState {
  name: string;
  scopes: PatScope[];
  grantMode: "" | "full" | "named";
  permissions: string[];
  tokens: PatToken[];
  menuLoaded: boolean;
}

/** The message each field would be refused with if Create token were pressed now. */
function validate(form: FormState): FormErrors {
  const next: FormErrors = {};
  const name = form.name.trim();
  if (!name) next.name = "Name is required.";
  else if (form.tokens.some((t) => t.name === name && !t.revokedAt)) next.name = PAT_NAME_IN_USE;
  if (form.scopes.length === 0) next.scopes = "Select at least one scope.";
  if (!form.grantMode) next.permissions = "Choose what this token may reach.";
  else if (form.grantMode === "named" && form.permissions.length === 0)
    next.permissions = "Pick at least one permission, or choose full access.";
  else if (!form.menuLoaded) next.permissions = "The permission menu hasn't loaded yet.";
  return next;
}

/** What each field holds, in the form a refusal is compared against. */
function heldValues(form: FormState): Record<FormField, string> {
  return {
    name: form.name.trim(),
    scopes: [...form.scopes].sort().join(","),
    permissions: `${form.grantMode}:${[...form.permissions].sort().join(",")}`,
  };
}

/** A refusal recorded on a press: its message, and the value the field held when it was refused. */
type Refusals = Partial<Record<FormField, { message: string; value: string }>>;

export function TokensTab() {
  const tokensQ = useTokens();
  const projectsQ = useProjects();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const reauth = useReauth();
  const { toast, dismiss } = useToast();
  const { user } = useAuth();

  // Default to the password prompt while /auth/me is still resolving — a
  // password user seeing it a beat early beats an SSO user seeing nothing.
  const hasPassword = user?.hasPassword ?? true;
  const linkedProviders = user?.oauthProviders ?? [];

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<PatScope[]>(["read"]);
  // ISS-1255 — the form picks no power on the minter's behalf. "" is "nothing
  // chosen yet", and it is what the create button is refused on.
  const [grantMode, setGrantMode] = useState<"" | "full" | "named">("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  // ISS-497 — "" = None (user-level); a project id = bind the token to it.
  const [boundProjectId, setBoundProjectId] = useState("");
  const [refusals, setRefusals] = useState<Refusals>({});
  // Create token sits below the whole form, so a refused field near its top is drawn off screen. The
  // first one refused is brought into view with the cursor in it, after the errors have rendered.
  const [refused, setRefused] = useState<{ field: FormField } | null>(null);
  const nameRef = useRef<HTMLDivElement>(null);
  const scopesRef = useRef<HTMLDivElement>(null);
  const permissionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!refused) return;
    const field = { name: nameRef, scopes: scopesRef, permissions: permissionsRef }[refused.field].current;
    field?.scrollIntoView({ block: "center", behavior: "smooth" });
    const control = field?.querySelector<HTMLElement>("input, button");
    control?.focus({ preventScroll: true });
    // A refused name is highlighted, so what the reader types next replaces it.
    if (control instanceof HTMLInputElement) control.select();
  }, [refused]);

  const projects = projectsQ.data ?? [];
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const projectOptions = [
    { value: "", label: "None — user-level / all my projects" },
    ...projects.map((p) => ({ value: p.id, label: `${p.name} (${p.slug})` })),
  ];
  /** Human level label for a token row: "User-level" or "Project: <name>", the slug only where the project has no name. */
  function levelLabel(t: PatToken): string {
    if (!t.boundProjectId) return "User-level";
    const project = projectsById.get(t.boundProjectId);
    return `Project: ${project?.name || project?.slug || t.boundProjectId.slice(0, 8)}`;
  }

  // One-time plaintext reveal.
  const [revealed, setRevealed] = useState<PatTokenCreated | null>(null);
  // The panel says its own copy result: a toast sits top right, over the drawer it would confirm.
  const [copyResult, setCopyResult] = useState<"copied" | "failed" | null>(null);

  // Fresh-auth re-prompt.
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState("");
  // The re-auth field opens below the whole form, under the fold on a laptop screen, so it is
  // brought into view, and the password box focused, the moment it is asked for.
  const reauthRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!needsReauth) return;
    const field = reauthRef.current;
    field?.scrollIntoView({ block: "center", behavior: "smooth" });
    field?.querySelector<HTMLInputElement>('input[type="password"]')?.focus({ preventScroll: true });
  }, [needsReauth]);

  const tokens = tokensQ.data?.tokens ?? [];
  // The menu the door will accept, served beside the list so the form cannot
  // offer a name the create call would be refused for.
  const menu = tokensQ.data?.menu ?? null;

  // A refusal describes what its field holds now: it is shown only while the field still holds the
  // value it refused and that value is still refused for the same reason.
  const form: FormState = { name, scopes, grantMode, permissions, tokens, menuLoaded: !!menu };
  const live = validate(form);
  const held = heldValues(form);
  const errors: FormErrors = {};
  for (const field of FIELD_ORDER) {
    const refusal = refusals[field];
    if (refusal && refusal.value === held[field] && refusal.message === live[field]) errors[field] = refusal.message;
  }

  // Consume the SSO reauth outcome on return: restore the draft on success,
  // surface the typed error on failure, and strip the params either way so a
  // refresh doesn't replay the toast.
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
          const draft = JSON.parse(raw) as {
            name?: string;
            scopes?: PatScope[];
            grantMode?: "" | "full" | "named";
            permissions?: string[];
            expiresAt?: string;
            boundProjectId?: string;
          };
          setName(draft.name ?? "");
          if (draft.scopes?.length) setScopes(draft.scopes);
          setGrantMode(draft.grantMode ?? "");
          setPermissions(draft.permissions ?? []);
          setExpiresAt(draft.expiresAt ?? "");
          setBoundProjectId(draft.boundProjectId ?? "");
        } catch {
          // corrupt draft — start clean
        }
      }
      toast({
        title: "Re-authenticated",
        description: "You're verified for the next few minutes — create your token now.",
        tone: "success",
        slot: FORM_NOTICE,
      });
    } else if (errCode) {
      toast({
        title: "Re-authentication failed",
        description: REAUTH_ERROR_MESSAGES[errCode] ?? errCode,
        tone: "error",
        slot: FORM_NOTICE,
      });
    }
  }, [toast]);

  /** Validate, stash the draft, and hand the browser to the provider. */
  function startSsoReauth(provider: string) {
    const input = buildInput();
    if (!input) return;
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ name, scopes, grantMode, permissions, expiresAt, boundProjectId }),
    );
    window.location.href = reauthStartUrl(provider, RETURN_PATH);
  }

  function toggleScope(scope: PatScope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  function togglePermission(permission: string) {
    setPermissions((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );
  }

  function buildInput(): CreatePatInput | null {
    const next: Refusals = {};
    for (const field of FIELD_ORDER) {
      const message = live[field];
      if (message) next[field] = { message, value: held[field] };
    }
    setRefusals(next);
    const first = FIELD_ORDER.find((field) => next[field]);
    if (first) setRefused({ field: first });
    if (first || !menu) return null;
    return {
      name: name.trim(),
      scopes,
      permissions: grantMode === "full" ? [menu.full] : permissions,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(boundProjectId ? { boundProjectId } : {}),
    };
  }

  function resetForm() {
    setName("");
    setScopes(["read"]);
    setGrantMode("");
    setPermissions([]);
    setExpiresAt("");
    setBoundProjectId("");
    setRefusals({});
  }

  function runCreate(input: CreatePatInput) {
    create.mutate(input, {
      onSuccess: (token) => {
        dismiss(FORM_NOTICE);
        setCopyResult(null);
        setRevealed(token);
        setNeedsReauth(false);
        setPassword("");
        resetForm();
      },
      onError: (err) => {
        if (isFreshAuthError(err)) {
          setNeedsReauth(true);
          toast({
            title: "Re-authenticate to continue",
            description: hasPassword
              ? "Confirm your password to create a token."
              : "Confirm with your sign-in provider to create a token.",
            tone: "info",
            slot: FORM_NOTICE,
          });
        } else {
          toast({ title: "Couldn't create token", description: formatApiError(err), tone: "error", slot: FORM_NOTICE });
        }
      },
    });
  }

  function onCreate() {
    const input = buildInput();
    if (input) runCreate(input);
  }

  function onConfirmReauth() {
    const input = buildInput();
    if (!input || !password) return;
    reauth.mutate(password, {
      onSuccess: () => runCreate(input),
      onError: (err) =>
        toast({ title: "Re-authentication failed", description: formatApiError(err), tone: "error", slot: FORM_NOTICE }),
    });
  }

  async function copyPlaintext() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.plaintext);
      setCopyResult("copied");
    } catch {
      setCopyResult("failed");
    }
  }

  return (
    <div className="space-y-8">
      {tokensQ.isLoading && (
        <div className="space-y-2.5">
          {["first", "second", "third"].map((row) => (
            <Skeleton key={row} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      )}

      {tokensQ.isError && (
        <ErrorState
          title="Couldn't load tokens"
          message={formatApiError(tokensQ.error)}
          onRetry={() => tokensQ.refetch()}
        />
      )}

      {!tokensQ.isLoading && !tokensQ.isError && (
        <TokenList
          tokens={tokens}
          level={levelLabel}
          onRevoke={(t) => revoke.mutate(t.id)}
          revoking={revoke.isPending}
        />
      )}

      <section aria-labelledby="create-a-token" className="border-t border-line pt-6">
        <div>
          <SectionTitle id="create-a-token" className="fg-h3 mb-4">Create a token</SectionTitle>
          <div className="space-y-4">
            <div ref={nameRef}>
              <Field label="Name" required error={errors.name}>
                <Input value={name} placeholder="e.g. CI deploy token" onChange={(e) => setName(e.target.value)} />
              </Field>
            </div>

            <div ref={scopesRef}>
              <Field label="Scopes" required error={errors.scopes} hint="What this token may do.">
                <div className="flex flex-wrap gap-4 pt-1">
                  {PAT_SCOPES.map((scope) => (
                    <Checkbox
                      key={scope}
                      checked={scopes.includes(scope)}
                      onChange={() => toggleScope(scope)}
                      label={scope}
                    />
                  ))}
                </div>
              </Field>
            </div>

            <div ref={permissionsRef}>
              <Field
                label="Permissions"
                required
                error={errors.permissions}
                hint="Which of the API this token reaches. Full access covers every permission, including any added later."
              >
                <RadioGroup name="pat-grant" value={grantMode} onChange={(v) => setGrantMode(v as "" | "full" | "named")}>
                  <Radio value="full" label="Full access — every permission on the menu" />
                  <Radio value="named" label="Only the permissions I pick" />
                </RadioGroup>
                {grantMode === "named" && (
                  <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {(menu?.permissions ?? []).map((permission) => (
                      <Checkbox
                        key={permission}
                        checked={permissions.includes(permission)}
                        onChange={() => togglePermission(permission)}
                        label={permission}
                      />
                    ))}
                  </div>
                )}
              </Field>
            </div>

            <Field label="Expires" hint="Optional. Leave blank for a non-expiring token.">
              <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
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
                value={boundProjectId}
                onChange={setBoundProjectId}
                disabled={projectsQ.isLoading}
                placeholder={projectsQ.isLoading ? "Loading…" : "None — user-level"}
              />
            </Field>

            <div ref={reauthRef} className="space-y-4 empty:hidden">
              {needsReauth && hasPassword && (
                <Field
                  label="Confirm password"
                  required
                  hint="Token creation requires a recent sign-in."
                >
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
                <Field
                  label="Re-authenticate"
                  hint={
                    linkedProviders.length > 0
                      ? "Token creation requires a recent sign-in. Confirm with your sign-in provider — you'll come right back here with the form intact."
                      : "Token creation requires a recent sign-in, but this account has no password and no linked sign-in provider. Ask an administrator for help."
                  }
                >
                  <div className="flex flex-wrap gap-3 pt-1">
                    {linkedProviders.map((p) => (
                      <Button
                        key={p}
                        variant="primary"
                        onClick={() => startSsoReauth(p)}
                        className="min-h-11"
                      >
                        Continue with {PROVIDER_LABELS[p] ?? p}
                      </Button>
                    ))}
                  </div>
                </Field>
              )}
            </div>

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
                  onClick={onCreate}
                  className="min-h-11"
                >
                  Create token
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>

      <SlideOver open={!!revealed} onClose={() => setRevealed(null)} title="Token created">
        {revealed && (
          <div className="space-y-4">
            <p className="fg-body-sm text-muted">
              Copy this token now — it won&apos;t be shown again.
            </p>
            {revealed.boundProjectId && (
              <p className="fg-body-sm text-muted">
                This is a project-level token bound to{" "}
                <span className="font-medium text-fg">
                  {projectsById.get(revealed.boundProjectId)?.slug ?? "the selected project"}
                </span>
                . MCP clients can omit the <code className="font-mono">X-Forge-Project-Slug</code>{" "}
                header — calls resolve to this project automatically.
              </p>
            )}
            <div className="border-y border-line py-3">
              <code className="block break-all font-mono text-13 text-fg">
                {revealed.plaintext}
              </code>
            </div>
            <div className="flex gap-3">
              <Button variant="primary" onClick={copyPlaintext} className="min-h-11">
                {copyResult === "copied" ? "Copied ✓" : "Copy to clipboard"}
              </Button>
              <Button variant="secondary" onClick={() => setRevealed(null)} className="min-h-11">
                Done
              </Button>
            </div>
            {copyResult === "failed" && (
              <p role="alert" className="fg-body-sm fg-danger">
                Copy failed. Select the token above and copy it by hand.
              </p>
            )}
          </div>
        )}
      </SlideOver>
    </div>
  );
}
