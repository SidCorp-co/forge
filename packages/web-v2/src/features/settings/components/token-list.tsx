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
    return <EmptyState title={t("settings.tokens.none")} message={t("settings.tokens.noneBody")} />;

  const props = (token: PatToken): RowProps => ({
    token,
    level: levelOf(token),
    onRevoke: () => onRevoke(token.id),
    pending,
  });
  const HEADS = [
    t("settings.agents.name"),
    t("settings.tokens.level"),
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
 * its minter chose, the names it was given, and the legacy shape a token
 * minted before a grant could be stated still carries — which reaches
 * everything too, and says so rather than reading as an absence.
 */
function GrantBadge({ token }: { token: PatToken }) {
  const t = useCopy();
  if (token.grant === "full") return <Badge tone="red">{t("settings.tokens.full")}</Badge>;
  if (token.grant === "legacy") return <Badge tone="amber">{t("settings.tokens.legacy")}</Badge>;
  const count = token.permissions?.length ?? 0;
  return (
    <Badge tone="neutral">
      {count === 1 ? t("settings.tokens.permissionOne") : t("settings.tokens.permissions", { n: count })}
    </Badge>
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
  const { token, level } = props;
  const t = useCopy();
  const fmtDate = useFmtDate();
  return (
    <TR>
      <TD className="font-medium text-fg">
        {token.name}
        {token.revokedAt && <span className="fg-caption ml-2">{t("settings.tokens.revoked")}</span>}
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
          {t("settings.tokens.expiresUsed", { expires: fmtDate(token.expiresAt), used: fmtDate(token.lastUsedAt) })}
        </p>
      </PageSectionBody>
    </PageSection>
  );
}
