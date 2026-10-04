"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  MonoTag,
  SectionTitle,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import { useRevokeToken, useTokens } from "../hooks";
import type { PatScope, PatToken } from "../types";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** The person's tokens, a table on desktop and a stack on a phone, each revocable. */
export function TokenList({ levelLabel }: { levelLabel: (t: PatToken) => string }) {
  const tokensQ = useTokens();
  const revoke = useRevokeToken();
  const tokens = tokensQ.data?.tokens ?? [];
  const ready = !tokensQ.isLoading && !tokensQ.isError;

  return (
    <div>
      <SectionTitle className="fg-h3 mb-3">Your tokens</SectionTitle>

      {tokensQ.isLoading && (
        <div className="space-y-2.5">
          {["first", "second", "third"].map((k) => (
            <Skeleton key={k} className="h-14 w-full rounded-lg" />
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

      {ready && tokens.length === 0 && (
        <EmptyState title="No tokens" message="Create a personal access token above to use the API." />
      )}

      {ready && tokens.length > 0 && (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Level</TH>
                  <TH>Prefix</TH>
                  <TH>Scopes</TH>
                  <TH>Grant</TH>
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
  );
}

/**
 * What this token may reach, in the three shapes the column has: full access
 * its minter chose, the names it was given, and the legacy shape a token
 * minted before a grant could be stated still carries — which reaches
 * everything too, and says so rather than reading as an absence.
 */
function GrantBadge({ token }: { token: PatToken }) {
  if (token.grant === "full") return <Badge tone="red">Full access</Badge>;
  if (token.grant === "legacy")
    return <Badge tone="amber">Legacy — full access, never stated</Badge>;
  const names = token.permissions ?? [];
  return (
    <Badge tone="neutral">
      {names.length} permission{names.length === 1 ? "" : "s"}
    </Badge>
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

interface TokenItemProps {
  token: PatToken;
  level: string;
  onRevoke: () => void;
  pending: boolean;
}

function RevokeButton({ token, onRevoke, pending }: Omit<TokenItemProps, "level">) {
  return (
    <Button
      variant="danger"
      size="sm"
      disabled={!!token.revokedAt || pending}
      onClick={onRevoke}
      className="min-h-11"
    >
      Revoke
    </Button>
  );
}

function TokenName({ token }: { token: PatToken }) {
  return (
    <>
      {token.name}
      {token.revokedAt && <span className="fg-caption ml-2">(revoked)</span>}
    </>
  );
}

function TokenRow({ token, level, onRevoke, pending }: TokenItemProps) {
  return (
    <TR>
      <TD className="font-medium text-fg">
        <TokenName token={token} />
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
      <TD>
        <GrantBadge token={token} />
      </TD>
      <TD className="font-mono text-muted">{fmtDate(token.expiresAt)}</TD>
      <TD className="font-mono text-muted">{fmtDate(token.lastUsedAt)}</TD>
      <TD className="text-right">
        <RevokeButton token={token} onRevoke={onRevoke} pending={pending} />
      </TD>
    </TR>
  );
}

function TokenMobileCard({ token, level, onRevoke, pending }: TokenItemProps) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="fg-body-sm font-medium text-fg">
              <TokenName token={token} />
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <MonoTag>{token.prefix}…</MonoTag>
              <Badge tone={token.boundProjectId ? "cobalt" : "neutral"}>{level}</Badge>
            </div>
          </div>
          <RevokeButton token={token} onRevoke={onRevoke} pending={pending} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ScopeBadges scopes={token.scopes} />
          <GrantBadge token={token} />
        </div>
        <p className="fg-caption mt-2 font-mono">
          Expires {fmtDate(token.expiresAt)} · Last used {fmtDate(token.lastUsedAt)}
        </p>
      </CardContent>
    </Card>
  );
}
