"use client";

// A project's share links, as core lists them (`GET /api/projects/:id/shares`): what each froze, who
// may open it, who made it, until when, how often it was opened, and where it stands. A row never
// holds its token or the token's hash; the link was shown once, when it was made. Revoking asks core,
// and the row reads revoked only when the list read again says so.

import { shareStateOf, type ShareLinkView } from "@forge/contracts/shares";
import { useState } from "react";
import { Button, ConfirmDialog, EmptyState, EnumBadge, PersonChip, Skeleton, Table, TBody, TD, TH, THead, TR } from "@/design";
import { useTimeFormat } from "@/lib/i18n/interface-language";
import { useAuth } from "@/providers/auth-provider";
import { useRevokeShare, useShares } from "../hooks";
import { ShareRefusal } from "./share-refusal";

export interface ShareListProps {
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

  if (sharesQ.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-9 w-full rounded-md" />
        <Skeleton className="h-9 w-2/3 rounded-md" />
      </div>
    );
  }
  if (sharesQ.isError) {
    return <ShareRefusal error={sharesQ.error} lead="Couldn't list this project's share links" />;
  }
  const shares = sharesQ.data ?? [];
  if (shares.length === 0) {
    return (
      <EmptyState
        title="No share links yet"
        message="Share an answer that holds a report block from its row in a conversation, then find the link here."
        mascot={false}
      />
    );
  }
  return (
    <>
      {revoke.isError && <ShareRefusal error={revoke.error} lead="Core refused to revoke the share" />}
      <Table aria-label="Share links" data-testid="share-list">
        <THead>
          <TR>
            <TH>Shared</TH>
            <TH>Who can open</TH>
            <TH>Created by</TH>
            <TH>Expires</TH>
            <TH className="text-right">Views</TH>
            <TH>Last viewed</TH>
            <TH>State</TH>
            <TH>
              <span className="sr-only">Actions</span>
            </TH>
          </TR>
        </THead>
        <TBody>
          {shares.map((share) => (
            <ShareRow
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
        title="Revoke this share link?"
        message="Anyone who opens it will be told it is not available. A revocation cannot be undone."
        confirmLabel="Revoke"
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

function ShareRow({
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
  const state = shareStateOf(share);
  return (
    <TR data-testid="share-row" data-share-id={share.id} data-state={state}>
      <TD>
        <span className="flex min-w-0 flex-col items-start gap-0.5" title={`Share ${share.id}, created ${time.dateTime(share.createdAt)}`}>
          {share.title && <span className="max-w-[24ch] truncate text-fg" data-testid="share-title">{share.title}</span>}
          <EnumBadge family="shareSubject" value={share.subjectKind} />
        </span>
      </TD>
      <TD>
        <EnumBadge family="shareAudience" value={share.audience} />
      </TD>
      <TD>
        {creator ? (
          <PersonChip name={you ? `${creator} (you)` : creator} you={you} />
        ) : (
          <span className="text-muted" title={share.createdBy}>
            Former member
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
          <span className="text-subtle">Never</span>
        )}
      </TD>
      <TD>
        <span title={share.revokedAt ? `Revoked ${time.dateTime(share.revokedAt)}` : undefined}>
          <EnumBadge family="shareState" value={state} />
        </span>
      </TD>
      <TD className="text-right">
        {state === "active" && canRevoke && (
          <Button type="button" size="sm" variant="ghost" loading={revoking} onClick={onRevoke} data-testid="share-revoke">
            Revoke
          </Button>
        )}
      </TD>
    </TR>
  );
}
