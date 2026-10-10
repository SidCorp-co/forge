"use client";

import {
  Badge,
  Button,
  PageSection,
  PageSectionBody,
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
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import type { useTokens } from "../hooks";
import type { PatToken } from "../types";

/** A token's date in the reader's words, or a dash where it has none. */
function useFmtDate(): (iso: string | null) => string {
  const time = useTimeFormat();
  return (iso) => (!iso || Number.isNaN(new Date(iso).getTime()) ? "—" : time.date(iso));
}

interface RowProps {
  token: PatToken;
  /** The slugs the token is fenced to, or null where it reaches every project. */
  reach: string[] | null;
  onRevoke: () => void;
  onEditProjects: () => void;
  pending: boolean;
}

export function TokenList({
  tokensQ,
  reachOf,
  onRevoke,
  onEditProjects,
  pending,
}: {
  tokensQ: ReturnType<typeof useTokens>;
  reachOf: (t: PatToken) => string[] | null;
  onRevoke: (id: string) => void;
  onEditProjects: (token: PatToken) => void;
  pending: boolean;
}) {
  const tokens = tokensQ.data?.tokens ?? [];
  const t = useCopy();
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
        title={t("settings.tokens.loadFailed")}
        message={formatApiError(tokensQ.error)}
        onRetry={() => tokensQ.refetch()}
      />
    );
  if (tokens.length === 0)
    return <EmptyState message={t("settings.tokens.none")} />;

  const props = (token: PatToken): RowProps => ({
    token,
    reach: reachOf(token),
    onRevoke: () => onRevoke(token.id),
    onEditProjects: () => onEditProjects(token),
    pending,
  });
  const HEADS = [
    t("settings.agents.name"),
    t("settings.tokens.projects"),
    t("settings.tokens.prefix"),
    t("settings.tokens.scopes"),
    t("settings.tokens.grant"),
    t("settings.tokens.expires"),
    t("settings.tokens.lastUsed"),
  ];
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <THead>
            <TR>
              {HEADS.map((h) => (
                <TH key={h}>{h}</TH>
              ))}
              <TH className="text-right">{t("settings.agents.actions")}</TH>
            </TR>
          </THead>
          <TBody>
            {tokens.map((token) => (
              <TokenRow key={token.id} {...props(token)} />
            ))}
          </TBody>
        </Table>
      </div>
      <div className="space-y-2.5 md:hidden">
        {tokens.map((token) => (
          <TokenMobileCard key={token.id} {...props(token)} />
        ))}
      </div>
    </>
  );
}

/**
 * What this token may reach, in the three shapes the column has: full access
 * its minter chose, the names it was given, and a grant never stated — which
 * every door refuses, so it reaches nothing and says to re-mint.
 */
function GrantBadge({ token }: { token: PatToken }) {
  const t = useCopy();
  if (token.grant === "full") return <Badge tone="red">{t("settings.tokens.full")}</Badge>;
  if (token.grant === "unstated") return <Badge tone="amber">{t("settings.tokens.unstated")}</Badge>;
  const count = token.permissions?.length ?? 0;
  return (
    <Badge tone="neutral">
      {count === 1 ? t("settings.tokens.permissionOne") : t("settings.tokens.permissions", { n: count })}
    </Badge>
  );
}

/**
 * What the token reaches: every project, or the slugs it is fenced to, with Edit where the holder may
 * change the list (FB-48).
 */
function Reach({ token, reach, onEditProjects }: RowProps) {
  const t = useCopy();
  if (reach === null) return <Badge tone="neutral">{t("settings.tokens.noneAll")}</Badge>;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {reach.map((slug) => (
        <Badge key={slug} tone="cobalt">
          {slug}
        </Badge>
      ))}
      {token.fenceEditable && !token.revokedAt && (
        <Button variant="ghost" size="sm" onClick={onEditProjects} data-testid={`token-projects-edit-${token.id}`}>
          {t("settings.tokens.projectsEdit")}
        </Button>
      )}
    </div>
  );
}

function ScopeBadges({ scopes }: { scopes: PatToken["scopes"] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((s) => (
        <Badge key={s} tone={s === "write" ? "amber" : "neutral"}>
          <span translate="no">{s}</span>
        </Badge>
      ))}
    </div>
  );
}

function RevokeButton({ token, onRevoke, pending }: RowProps) {
  const t = useCopy();
  return (
    <Button
      variant="danger"
      size="sm"
      disabled={!!token.revokedAt || pending}
      onClick={onRevoke}
      className="min-h-11"
    >
      {t("settings.agents.revoke")}
    </Button>
  );
}

function TokenRow(props: RowProps) {
  const { token } = props;
  const t = useCopy();
  const fmtDate = useFmtDate();
  return (
    <TR>
      <TD className="font-medium text-fg">
        {token.name}
        {token.revokedAt && <span className="fg-caption ml-2">{t("settings.tokens.revoked")}</span>}
      </TD>
      <TD>
        <Reach {...props} />
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
  const { token } = props;
  const t = useCopy();
  const fmtDate = useFmtDate();
  return (
    <PageSection>
      <PageSectionBody>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="fg-body-sm font-medium text-fg">
              {token.name}
        {token.revokedAt && <span className="fg-caption ml-2">{t("settings.tokens.revoked")}</span>}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <MonoTag>{token.prefix}…</MonoTag>
            </div>
          </div>
          <RevokeButton {...props} />
        </div>
        <div className="mt-3">
          <Reach {...props} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <ScopeBadges scopes={token.scopes} />
          <GrantBadge token={token} />
        </div>
        <p className="fg-caption mt-2 font-mono">
          {t("settings.tokens.expiresUsed", { expires: fmtDate(token.expiresAt), used: fmtDate(token.lastUsedAt) })}
        </p>
      </PageSectionBody>
    </PageSection>
  );
}
