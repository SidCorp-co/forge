"use client";

// The acts the assistant offers in a thread (`offer_act`): a button the person presses, which runs as
// them through the issue page's own routes. A card whose issue has moved since the offer offers
// nothing, so a pressed or overtaken offer cannot be pressed twice.

import { CHAT_ACT_TOOL, type ChatActOffer, readChatActOffer } from "@forge/contracts/chat-acts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Button, Icon } from "@/design";
import type { CanonicalBlock } from "@/features/session/types";
import { issuesApi, releaseBatchApi } from "@/features/issues/api";
import { useIssue } from "@/features/issues/detail-hooks";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { ConversationMessage, ConversationProgressEntry } from "./types";
import { textOf } from "./ui-actions/actions";

/** Every offer an entry's blocks carry, in the order the turn made them. */
export function actOffersOf(blocks: readonly CanonicalBlock[] | null | undefined): ChatActOffer[] {
  const out: ChatActOffer[] = [];
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || b.toolCall?.name !== CHAT_ACT_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    const offer = readChatActOffer(textOf(b.toolCall.output));
    if (offer) out.push(offer);
  }
  return out;
}

/** What pressing the button calls: the route the issue page uses for the same act. */
export function pressAct(offer: ChatActOffer): Promise<unknown> {
  switch (offer.effect) {
    case "admit":
      return issuesApi.transition(offer.issueId, "open");
    case "run-step":
      return issuesApi.runPipelineStep(offer.issueId);
    case "transition":
      if (!offer.to) throw new Error(`a ${offer.act} offer on ${offer.key} names no status to move to`);
      return issuesApi.transition(offer.issueId, offer.to, offer.reason ? { reason: offer.reason } : undefined);
    case "release":
      return releaseBatchApi.create(offer.projectId, [offer.issueId]);
  }
}

export function useActOffers(args: {
  messages: readonly ConversationMessage[];
  progress: ConversationProgressEntry | null | undefined;
}) {
  const byEntry = useMemo(() => {
    const map = new Map<string, ChatActOffer[]>();
    for (const m of args.messages) {
      const offers = actOffersOf(m.blocks);
      if (offers.length > 0) map.set(m.id, offers);
    }
    if (args.progress) {
      const offers = actOffersOf(args.progress.entry.blocks as CanonicalBlock[]);
      if (offers.length > 0) map.set(args.progress.entry.id ?? "live", offers);
    }
    return map;
  }, [args.messages, args.progress]);

  const offersFor = useCallback(
    (entryId: string) => {
      const offers = byEntry.get(entryId);
      if (!offers) return null;
      return (
        <div className="mt-2 flex flex-col gap-2">
          {offers.map((o) => (
            <ActOfferCard key={`${o.issueId}:${o.act}`} offer={o} />
          ))}
        </div>
      );
    },
    [byEntry],
  );
  return { offersFor };
}

function ActOfferCard({ offer }: { offer: ChatActOffer }) {
  const t = useCopy();
  const L = useLabel();
  const qc = useQueryClient();
  const live = useIssue(offer.issueId, offer.projectId);
  const press = useMutation({
    mutationFn: () => pressAct(offer),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issues"] });
      qc.invalidateQueries({ queryKey: ["issue", offer.issueId] });
      qc.invalidateQueries({ queryKey: ["release-roster"] });
    },
  });
  const status = live.data?.status;
  const moved = !press.isSuccess && status !== undefined && status !== offer.from;
  const what =
    offer.effect === "transition" && offer.to
      ? t("conversations.act.what.transition", {
          key: offer.key,
          from: L("issueStatus", offer.from),
          to: L("issueStatus", offer.to),
        })
      : t(`conversations.act.what.${offer.effect}`, { key: offer.key });
  return (
    <div
      data-testid="act-offer"
      data-act={offer.act}
      className="flex flex-col gap-1.5 border-l-2 border-line py-1 pl-3"
    >
      <p className="fg-body-sm font-semibold text-fg">
        {t(`conversations.act.title.${offer.act}`, { key: offer.key })}
        <span className="font-normal text-muted"> · {offer.title}</span>
      </p>
      <p className="fg-caption text-muted">
        {what} {t("conversations.act.yours")}
      </p>
      {offer.reason && <p className="fg-caption text-subtle">“{offer.reason}”</p>}
      {press.isSuccess ? (
        <p className="fg-caption flex items-center gap-1 text-fg" role="status">
          <Icon name="check" size={12} />
          {t("conversations.act.done")}
        </p>
      ) : moved ? (
        <p className="fg-caption text-subtle" role="status">
          {t("conversations.act.moved", { key: offer.key, status: L("issueStatus", status) })}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={offer.act === "drop" ? "danger" : "primary"}
            loading={press.isPending}
            disabled={live.isLoading}
            onClick={() => press.mutate()}
          >
            {t("conversations.act.confirm")}
          </Button>
        </div>
      )}
      {press.isError && (
        <p className="fg-caption text-danger" role="alert">
          {formatApiError(press.error)}
        </p>
      )}
    </div>
  );
}
