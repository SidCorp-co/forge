"use client";

// A project's share links, as core lists them (`GET /api/projects/:id/shares`): what each froze, who
// may open it, who made it, until when, how often it was opened, and where it stands. A row never
// holds its token or the token's hash; the link was shown once, when it was made. Revoking asks core,
// and the row reads revoked only when the list read again says so.

import { shareStateOf, type ShareLinkView } from "@forge/contracts/shares";
import { useState } from "react";
import { Button, ConfirmDialog, EmptyState, EnumBadge, PersonChip, Skeleton, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useCopy, useTimeFormat } from "@/lib/i18n/interface-language";
import { useAuth } from "@/providers/auth-provider";
import { useRevokeShare, useShares } from "../hooks";
import { ShareRefusal } from "./share-refusal";

interface ShareListProps {
  projectId: string;
  /** A member's name by user id; null for someone no longer on the project. */
  nameOf: (userId: string) => string | null;
  /** Whether the reader holds project admin, so may revoke any share; core still decides. */
  isAdmin: boolean;
}

export function ShareList({ projectId, nameOf, isAdmin }: ShareListProps) {
  const sharesQ = useShares(projectId);
  const revoke = useRevokeShare(projectId);
  const [pending, setPending] = useState<ShareLinkView | null>(null);
  const me = useAuth().user?.id ?? null;
  const t = useCopy();

  if (sharesQ.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-2/3 rounded-md" />
      </div>
    );
  }
  if (sharesQ.isError) {
    return <ShareRefusal error={sharesQ.error} lead={t("shares.list.error")} />;
  }
  const shares = sharesQ.data ?? [];
  if (shares.length === 0) {
    return (
      <EmptyState message={t("shares.list.empty")} mascot={false} />
    );
  }
  return (
    <>
      {revoke.isError && <ShareRefusal error={revoke.error} lead={t("shares.list.revokeRefused")} />}
      <Table aria-label={t("shares.list.title")} data-testid="share-list">
        <THead>
          <TR>
            <TH>{t("shares.list.col.shared")}</TH>
            <TH>{t("shares.list.col.audience")}</TH>
            <TH>{t("shares.list.col.createdBy")}</TH>
            <TH>{t("shares.list.col.expires")}</TH>
            <TH className="text-right">{t("shares.list.col.views")}</TH>
            <TH>{t("shares.list.col.lastViewed")}</TH>
            <TH>{t("shares.list.col.state")}</TH>
            <TH>
              <span className="sr-only">{t("shares.list.col.actions")}</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {shares.map((share) => (
            <ShareItem
              key={share.id}
              share={share}
              creator={nameOf(share.createdBy)}
              you={share.createdBy === me}
              canRevoke={share.createdBy === me || isAdmin}
              revoking={revoke.isPending && revoke.variables === share.id}
              onRevoke={() => {
                revoke.reset();
                setPending(share);
              }}
            />
          ))}
        </TBody>
      </Table>
      <ConfirmDialog
        open={pending !== null}
        title={t("shares.list.revokeConfirm")}
        message={t("shares.list.revokeConfirm.body")}
        confirmLabel={t("shares.list.revoke")}
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => {
          if (!pending) return;
          revoke.mutate(pending.id, { onSettled: () => setPending(null) });
        }}
        onClose={() => setPending(null)}
      />
    </>
  );
}

function ShareItem({
  share,
  creator,
  you,
  canRevoke,
  revoking,
  onRevoke,
}: {
  share: ShareLinkView;
  creator: string | null;
  you: boolean;
  canRevoke: boolean;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const time = useTimeFormat();
  const t = useCopy();
  const state = shareStateOf(share);
  return (
    <TR data-testid="share-row" data-share-id={share.id} data-state={state}>
      <TD>
        <span className="flex min-w-0 flex-col items-start gap-0.5" title={t("shares.list.created", { at: time.dateTime(share.createdAt) })}>
          {share.title && <span className="max-w-60 truncate text-fg" data-testid="share-title">{share.title}</span>}
          <EnumBadge family="shareSubject" value={share.subjectKind} />
        </span>
      </TD>
      <TD>
        <EnumBadge family="shareAudience" value={share.audience} />
      </TD>
      <TD>
        {creator ? (
          <PersonChip name={you ? t("shares.list.you", { name: creator }) : creator} you={you} />
        ) : (
          <span className="text-muted" title={share.createdBy}>
            {t("shares.list.formerMember")}
          </span>
        )}
      </TD>
      <TD>
        <time dateTime={share.expiresAt} title={time.dateTime(share.expiresAt)}>
          {time.date(share.expiresAt)}
        </time>
      </TD>
      <TD className="text-right tabular-nums">{time.number(share.viewCount)}</TD>
      <TD>
        {share.lastViewedAt ? (
          <time dateTime={share.lastViewedAt} title={time.dateTime(share.lastViewedAt)}>
            {time.relative(share.lastViewedAt)}
          </time>
        ) : (
          <span className="text-subtle">{t("shares.list.never")}</span>
        )}
      </TD>
      <TD>
        <span title={share.revokedAt ? t("shares.list.revokedAt", { at: time.dateTime(share.revokedAt) }) : undefined}>
          <EnumBadge family="shareState" value={state} />
        </span>
      </TD>
      <TD className="text-right">
        {state === "active" && canRevoke && (
          <Button type="button" size="sm" variant="ghost" loading={revoking} onClick={onRevoke} data-testid="share-revoke">
            {t("shares.list.revoke")}
          </Button>
        )}
      </TD>
    </TR>
  );
}
