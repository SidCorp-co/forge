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
import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  MonoTag,
  Select,
  Skeleton,
  SlideOver,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { reauthStartUrl } from "@/features/auth/oauth-api";
import { useProjects } from "@/features/projects/hooks";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useAuth } from "@/providers/auth-provider";
import { useToast } from "@/providers/toast-provider";
import { useCreateToken, useReauth, useRevokeToken, useTokens } from "../hooks";
import {
  PAT_SCOPES,
  type CreatePatInput,
  type PatScope,
  type PatToken,
  type PatTokenCreated,
} from "../types";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function isFreshAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === "FRESH_AUTH_REQUIRED" || err.status === 403);
}

// Where the SSO reauth round-trip returns to (this tab).
const RETURN_PATH = "/settings?tab=tokens";

// Form draft persisted across the SSO reauth full-page redirect.
const DRAFT_KEY = "forge.settings.token-draft";

const PROVIDER_LABELS: Record<string, string> = {
  github: "GitHub",
  google: "Google",
  oidc: "SSO",
};

const REAUTH_ERROR_MESSAGES: Record<string, string> = {
  oauth_not_linked: "Your account isn't linked to that provider.",
  identity_mismatch: "The provider account doesn't match the one linked to your Forge account.",
};

export function TokensTab() {
  const tokensQ = useTokens();
  const projectsQ = useProjects();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const reauth = useReauth();
  const { toast } = useToast();
  const { user } = useAuth();

  // Default to the password prompt while /auth/me is still resolving — a
  // password user seeing it a beat early beats an SSO user seeing nothing.
  const hasPassword = user?.hasPassword ?? true;
  const linkedProviders = user?.oauthProviders ?? [];

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<PatScope[]>(["read"]);
  const [expiresAt, setExpiresAt] = useState("");
  // ISS-497 — "" = None (user-level); a project id = bind the token to it.
  const [boundProjectId, setBoundProjectId] = useState("");
  const [errors, setErrors] = useState<{ name?: string; scopes?: string }>({});

  const projects = projectsQ.data ?? [];
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const projectOptions = [
    { value: "", label: "None — user-level / all my projects" },
    ...projects.map((p) => ({ value: p.id, label: `${p.name} (${p.slug})` })),
  ];
  /** Human level label for a token row: "User-level" or "Project: <slug>". */
  function levelLabel(t: PatToken): string {
    if (!t.boundProjectId) return "User-level";
    return `Project: ${projectsById.get(t.boundProjectId)?.slug ?? t.boundProjectId.slice(0, 8)}`;
  }

  // One-time plaintext reveal.
  const [revealed, setRevealed] = useState<PatTokenCreated | null>(null);

  // Fresh-auth re-prompt.
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState("");

  const tokens = tokensQ.data?.tokens ?? [];

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
            expiresAt?: string;
            boundProjectId?: string;
          };
          setName(draft.name ?? "");
          if (draft.scopes?.length) setScopes(draft.scopes);
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
      });
    } else if (errCode) {
      toast({
        title: "Re-authentication failed",
        description: REAUTH_ERROR_MESSAGES[errCode] ?? errCode,
        tone: "error",
      });
    }
  }, [toast]);

  /** Validate, stash the draft, and hand the browser to the provider. */
  function startSsoReauth(provider: string) {
    const input = buildInput();
    if (!input) return;
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name, scopes, expiresAt, boundProjectId }));
    window.location.href = reauthStartUrl(provider, RETURN_PATH);
  }

  function toggleScope(scope: PatScope) {
    setScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
    );
  }

  function buildInput(): CreatePatInput | null {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Name is required.";
    else if (tokens.some((t) => t.name === name.trim() && !t.revokedAt))
      next.name = "An active token already uses this name.";
    if (scopes.length === 0) next.scopes = "Select at least one scope.";
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      name: name.trim(),
      scopes,
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      ...(boundProjectId ? { boundProjectId } : {}),
    };
  }

  function resetForm() {
    setName("");
    setScopes(["read"]);
    setExpiresAt("");
    setBoundProjectId("");
    setErrors({});
  }

  function runCreate(input: CreatePatInput) {
    create.mutate(input, {
      onSuccess: (token) => {
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
          });
        } else {
          toast({ title: "Couldn't create token", description: formatApiError(err), tone: "error" });
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
        toast({ title: "Re-authentication failed", description: formatApiError(err), tone: "error" }),
    });
  }

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
    <div className="space-y-6">
      <Card>
        <CardContent>
          <h2 className="fg-h3 mb-4">Create a token</h2>
          <div className="space-y-4">
            <Field label="Name" required error={errors.name}>
              <Input
                value={name}
                placeholder="e.g. CI deploy token"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>

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
        </CardContent>
      </Card>

      <div>
        <h2 className="fg-h3 mb-3">Your tokens</h2>

        {tokensQ.isLoading && (
          <div className="space-y-2.5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-lg" />
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

        {!tokensQ.isLoading && !tokensQ.isError && tokens.length === 0 && (
          <EmptyState title="No tokens" message="Create a personal access token above to use the API." />
        )}

        {!tokensQ.isLoading && !tokensQ.isError && tokens.length > 0 && (
          <>
            <div className="hidden md:block">
              <Table>
                <THead>
                  <TR>
                    <TH>Name</TH>
                    <TH>Level</TH>
                    <TH>Prefix</TH>
                    <TH>Scopes</TH>
                    <TH>Expires</TH>
                    <TH>Last used</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {tokens.map((t) => (
                    <TokenRow
                      key={t.id}
                      token={t}
                      level={levelLabel(t)}
                      onRevoke={() => revoke.mutate(t.id)}
                      pending={revoke.isPending}
                    />
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="space-y-2.5 md:hidden">
              {tokens.map((t) => (
                <TokenMobileCard
                  key={t.id}
                  token={t}
                  level={levelLabel(t)}
                  onRevoke={() => revoke.mutate(t.id)}
                  pending={revoke.isPending}
                />
              ))}
            </div>
          </>
        )}
      </div>

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
            <div className="rounded-md border border-line bg-sunken p-3">
              <code className="block break-all font-mono text-[13px] text-fg">
                {revealed.plaintext}
              </code>
            </div>
            <div className="flex gap-3">
              <Button variant="primary" icon="check" onClick={copyPlaintext} className="min-h-11">
                Copy to clipboard
              </Button>
              <Button variant="secondary" onClick={() => setRevealed(null)} className="min-h-11">
                Done
              </Button>
            </div>
          </div>
        )}
      </SlideOver>
    </div>
  );
}

function ScopeBadges({ scopes }: { scopes: PatScope[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} tone={s === "admin" ? "red" : s === "write" ? "amber" : "neutral"}>
          {s}
        </Badge>
      ))}
    </div>
  );
}

function TokenRow({
  token,
  level,
  onRevoke,
  pending,
}: {
  token: PatToken;
  level: string;
  onRevoke: () => void;
  pending: boolean;
}) {
  const revoked = !!token.revokedAt;
  return (
    <TR>
      <TD className="font-medium text-fg">
        {token.name}
        {revoked && <span className="fg-caption ml-2">(revoked)</span>}
      </TD>
      <TD>
        <Badge tone={token.boundProjectId ? "cobalt" : "neutral"}>{level}</Badge>
      </TD>
      <TD>
        <MonoTag>{token.prefix}…</MonoTag>
      </TD>
      <TD>
        <ScopeBadges scopes={token.scopes} />
      </TD>
      <TD className="font-mono text-muted">{fmtDate(token.expiresAt)}</TD>
      <TD className="font-mono text-muted">{fmtDate(token.lastUsedAt)}</TD>
      <TD className="text-right">
        <Button
          variant="danger"
          size="sm"
          disabled={revoked || pending}
          onClick={onRevoke}
          className="min-h-11"
        >
          Revoke
        </Button>
      </TD>
    </TR>
  );
}

function TokenMobileCard({
  token,
  level,
  onRevoke,
  pending,
}: {
  token: PatToken;
  level: string;
  onRevoke: () => void;
  pending: boolean;
}) {
  const revoked = !!token.revokedAt;
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="fg-body-sm font-medium text-fg">
              {token.name}
              {revoked && <span className="fg-caption ml-2">(revoked)</span>}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <MonoTag>{token.prefix}…</MonoTag>
              <Badge tone={token.boundProjectId ? "cobalt" : "neutral"}>{level}</Badge>
            </div>
          </div>
          <Button
            variant="danger"
            size="sm"
            disabled={revoked || pending}
            onClick={onRevoke}
            className="min-h-11"
          >
            Revoke
          </Button>
        </div>
        <div className="mt-3">
          <ScopeBadges scopes={token.scopes} />
        </div>
        <p className="fg-caption mt-2 font-mono">
          Expires {fmtDate(token.expiresAt)} · Last used {fmtDate(token.lastUsedAt)}
        </p>
      </CardContent>
    </Card>
  );
}
