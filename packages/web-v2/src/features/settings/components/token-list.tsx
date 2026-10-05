"use client";

import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  MonoTag,
  Skeleton,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
} from "@/design";
import { formatApiError } from "@/lib/api/error";
import type { useTokens } from "../hooks";
import type { PatToken } from "../types";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

interface RowProps {
  token: PatToken;
  /** "User-level" or "Project: <slug>". */
  level: string;
  onRevoke: () => void;
  pending: boolean;
}

export function TokenList({
  tokensQ,
  levelOf,
  onRevoke,
  pending,
}: {
  tokensQ: ReturnType<typeof useTokens>;
  levelOf: (t: PatToken) => string;
  onRevoke: (id: string) => void;
  pending: boolean;
}) {
  const tokens = tokensQ.data?.tokens ?? [];
  if (tokensQ.isLoading)
    return (
      <div className="space-y-2.5">
        {["a", "b", "c"].map((k) => (
          <Skeleton key={k} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  if (tokensQ.isError)
    return (
      <ErrorState
        title="Couldn't load tokens"
        message={formatApiError(tokensQ.error)}
        onRetry={() => tokensQ.refetch()}
      />
    );
  if (tokens.length === 0)
    return <EmptyState title="No tokens" message="Create a personal access token above to use the API." />;

  const props = (t: PatToken): RowProps => ({
    token: t,
    level: levelOf(t),
    onRevoke: () => onRevoke(t.id),
    pending,
  });
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <TR>
              {["Name", "Level", "Prefix", "Scopes", "Grant", "Expires", "Last used"].map((h) => (
                <TH key={h}>{h}</TH>
              ))}
              <TH className="text-right">Actions</TH>
            </TR>
          </THead>
          <TBody>
            {tokens.map((t) => (
              <TokenRow key={t.id} {...props(t)} />
            ))}
          </TBody>
        </Table>
      </div>
      <div className="space-y-2.5 md:hidden">
        {tokens.map((t) => (
          <TokenMobileCard key={t.id} {...props(t)} />
        ))}
      </div>
    </>
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
  if (token.grant === "legacy") return <Badge tone="amber">Legacy — full access, never stated</Badge>;
  const count = token.permissions?.length ?? 0;
  return (
    <Badge tone="neutral">
      {count} permission{count === 1 ? "" : "s"}
    </Badge>
  );
}

function ScopeBadges({ scopes }: { scopes: PatToken["scopes"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} tone={s === "write" ? "amber" : "neutral"}>
          {s}
        </Badge>
      ))}
    </div>
  );
}

function RevokeButton({ token, onRevoke, pending }: RowProps) {
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

function TokenRow(props: RowProps) {
  const { token, level } = props;
  return (
    <TR>
      <TD className="font-medium text-fg">
        {token.name}
        {token.revokedAt && <span className="fg-caption ml-2">(revoked)</span>}
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
        <RevokeButton {...props} />
      </TD>
    </TR>
  );
}

function TokenMobileCard(props: RowProps) {
  const { token, level } = props;
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="fg-body-sm font-medium text-fg">
              {token.name}
        {token.revokedAt && <span className="fg-caption ml-2">(revoked)</span>}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <MonoTag>{token.prefix}…</MonoTag>
              <Badge tone={token.boundProjectId ? "cobalt" : "neutral"}>{level}</Badge>
            </div>
          </div>
          <RevokeButton {...props} />
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
