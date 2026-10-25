
// The acts the assistant offers in a thread (`offer_act`): a button the person presses, which runs as
// them through the issue page's own routes. A card whose issue has moved since the offer offers
// nothing, so a pressed or overtaken offer cannot be pressed twice. A drop card shows the issue's
// open questions, answerable there, and the press voids the rest with the offer's reason (ISS-560).

import { CHAT_ACT_TOOL, type ChatActOffer, readChatActOffer } from "@forge/contracts/chat-acts";
import type { IdeaOffer } from "@forge/contracts/idea-offer";
import type { ItemActOffer } from "@forge/contracts/item-acts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Button, Icon } from "@/design";
import type { CanonicalBlock } from "@/features/session";
import { endsTheIssue, issuesApi, MootQuestions, releaseBatchApi, useIssue, useMootQuestions } from "@/features/issues";
import { questionKeys } from "@/features/questions";
import { IdeaOfferNotice, ideaOffersOf } from "./components/idea-offers";
import { nextStepOf } from "./act-next-step";
import { itemActOffersOf } from "./item-act-card";
import { ItemActOfferNotice } from "./item-act-offers";
import { ApiError } from "@/lib/api/client";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { ConversationMessage, ConversationProgressEntry } from "./types";
import { toolOutputText } from "@/lib/tool-output";

/** Every offer an entry's blocks carry, in the order the turn made them. */
export function actOffersOf(blocks: readonly CanonicalBlock[] | null | undefined): ChatActOffer[] {
  const out: ChatActOffer[] = [];
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || b.toolCall?.name !== CHAT_ACT_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    const offer = readChatActOffer(toolOutputText(b.toolCall.output));
    if (offer) out.push(offer);
  }
  return out;
}

/**
 * What pressing the button calls: the route the issue page uses for the same act. `voids` is set
 * when the card listed open questions the move ends: they are voided with the offer's reason.
 */
export function pressAct(offer: ChatActOffer, opts?: { voids?: boolean }): Promise<unknown> {
  switch (offer.effect) {
    case "admit":
      return issuesApi.transition(offer.issueId, "open");
    case "run-step":
      return issuesApi.runPipelineStep(offer.issueId);
    case "transition":
      if (!offer.to) throw new Error(`a ${offer.act} offer on ${offer.key} names no status to move to`);
      return issuesApi.transition(
        offer.issueId,
        offer.to,
        offer.reason ? { reason: offer.reason, ...(opts?.voids ? { voidQuestions: offer.reason } : {}) } : undefined,
      );
    case "release":
      return releaseBatchApi.create(offer.projectId, [offer.issueId]);
  }
}

export function useActOffers(args: {
  messages: readonly ConversationMessage[];
  progress: ConversationProgressEntry | null | undefined;
  /** The project's slug, for the link a failed card names; plain text until it is known. */
  slug?: string | undefined;
}) {
  const byEntry = useMemo(() => {
    const map = new Map<string, { acts: ChatActOffer[]; items: ItemActOffer[]; ideas: IdeaOffer[] }>();
    const note = (id: string, blocks: readonly CanonicalBlock[] | null | undefined) => {
      const acts = actOffersOf(blocks);
      const items = itemActOffersOf(blocks);
      const ideas = ideaOffersOf(blocks);
      if (acts.length + items.length + ideas.length > 0) map.set(id, { acts, items, ideas });
    };
    for (const m of args.messages) note(m.id, m.blocks);
    if (args.progress) note(args.progress.entry.id ?? "live", args.progress.entry.blocks);
    return map;
  }, [args.messages, args.progress]);

  const offersFor = useCallback(
    (entryId: string) => {
      const offers = byEntry.get(entryId);
      if (!offers) return null;
      return (
        <div className="mt-2 flex flex-col gap-2">
          {offers.acts.map((o) => (
            <ActOfferNotice key={`${o.issueId}:${o.act}`} offer={o} />
          ))}
          {offers.items.map((o) => (
            <ItemActOfferNotice key={`${o.ref}:${o.act}`} offer={o} slug={args.slug} />
          ))}
          {offers.ideas.map((o) => (
            <IdeaOfferNotice key={`${o.about}:${o.brief}`} offer={o} />
          ))}
        </div>
      );
    },
    [byEntry, args.slug],
  );
  return { offersFor };
}

/** A drop refused because a question was asked after the card read the issue's questions. */
const questionsOpened = (err: unknown): boolean => err instanceof ApiError && err.code === "OPEN_QUESTIONS";

function ActOfferNotice({ offer }: { offer: ChatActOffer }) {
  const t = useCopy();
  const L = useLabel();
  const qc = useQueryClient();
  const live = useIssue(offer.issueId, offer.projectId);
  const ends = offer.effect === "transition" && endsTheIssue(offer.to);
  const moot = useMootQuestions(ends ? offer.issueId : null);
  const press = useMutation({
    mutationFn: () => pressAct(offer, { voids: moot.open.length > 0 }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["issues"] });
      void qc.invalidateQueries({ queryKey: ["issue", offer.issueId] });
      void qc.invalidateQueries({ queryKey: ["release-roster"] });
      void qc.invalidateQueries({ queryKey: questionKeys.issue(offer.issueId) });
    },
    onError: (err) => {
      if (questionsOpened(err)) void qc.invalidateQueries({ queryKey: questionKeys.issue(offer.issueId) });
    },
  });
  const status = live.data?.status;
  const moved = !press.isSuccess && status !== undefined && status !== offer.from;
  const open = !press.isSuccess && !moved;
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
      {ends && open && <MootQuestions issueId={offer.issueId} />}
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
            disabled={live.isLoading || moot.loading}
            onClick={() => press.mutate()}
          >
            {t("conversations.act.confirm")}
          </Button>
        </div>
      )}
      {press.isError && (
        <div className="fg-caption flex flex-col gap-0.5" role="alert">
          <p className="text-danger">{questionsOpened(press.error) ? t("conversations.act.questionOpened") : formatApiError(press.error)}</p>
          <p className="text-muted">{t(`conversations.next.${nextStepOf(press.error)}`)}</p>
        </div>
      )}
    </div>
  );
}
