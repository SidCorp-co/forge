"use client";

// Settings → API Tokens. List + create (one-time plaintext reveal) + revoke.
// Create/revoke require fresh auth (≤5 min); a 403 FRESH_AUTH_REQUIRED swaps the
// form for an inline re-auth prompt, then retries the pending create.
import { useState } from "react";
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
  Skeleton,
  SlideOver,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
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

export function TokensTab() {
  const tokensQ = useTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const reauth = useReauth();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<PatScope[]>(["read"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [errors, setErrors] = useState<{ name?: string; scopes?: string }>({});

  // One-time plaintext reveal.
  const [revealed, setRevealed] = useState<PatTokenCreated | null>(null);

  // Fresh-auth re-prompt.
  const [needsReauth, setNeedsReauth] = useState(false);
  const [password, setPassword] = useState("");

  const tokens = tokensQ.data?.tokens ?? [];

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
    };
  }

  function resetForm() {
    setName("");
    setScopes(["read"]);
    setExpiresAt("");
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
            description: "Confirm your password to create a token.",
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

            {needsReauth && (
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

            <div className="flex flex-wrap gap-3">
              {needsReauth ? (
                <Button
                  variant="primary"
                  loading={reauth.isPending || create.isPending}
                  disabled={!password}
                  onClick={onConfirmReauth}
                  className="min-h-11"
                >
                  Confirm &amp; create
                </Button>
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
                    <TH>Prefix</TH>
                    <TH>Scopes</TH>
                    <TH>Expires</TH>
                    <TH>Last used</TH>
                    <TH className="text-right">Actions</TH>
                  </TR>
                </THead>
                <TBody>
                  {tokens.map((t) => (
                    <TokenRow key={t.id} token={t} onRevoke={() => revoke.mutate(t.id)} pending={revoke.isPending} />
                  ))}
                </TBody>
              </Table>
            </div>
            <div className="space-y-2.5 md:hidden">
              {tokens.map((t) => (
                <TokenMobileCard
                  key={t.id}
                  token={t}
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
  onRevoke,
  pending,
}: {
  token: PatToken;
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
  onRevoke,
  pending,
}: {
  token: PatToken;
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
