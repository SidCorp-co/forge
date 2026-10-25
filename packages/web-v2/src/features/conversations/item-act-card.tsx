// The card of a Product act the assistant offers on an item (`offer_item_act`, REQ-69 BC-3, BC-5).
// Before the press it says what the act records; after it, the item's new state, or why it failed and
// what to do next. A card whose item has moved since the offer offers nothing, so it cannot be pressed
// twice. What the press calls and how the item is read now are the adapter's (`item-act-offers.tsx`).

import { ITEM_ACT_TOOL, type ItemActOffer, itemActKind, readItemActOffer } from "@forge/contracts/item-acts";
import { useMutation } from "@tanstack/react-query";
import { Button, Icon } from "@/design";
import type { CanonicalBlock } from "@/features/session";
import { formatApiError } from "@/lib/api/error";
import { useCopy, useLabel } from "@/lib/i18n/interface-language";
import type { ProductCopyKey } from "@/lib/i18n/product-copy";
import { Link } from "@/lib/navigation/router";
import { feedbackHref } from "@/lib/routes/feedback";
import { releaseHref } from "@/lib/routes/releases";
import { requirementHref } from "@/lib/routes/requirements";
import { workflowHref } from "@/lib/routes/workflows";
import { toolOutputText } from "@/lib/tool-output";
import { nextStepOf } from "./act-next-step";

/** Every item act an entry's blocks offer, in the order the turn made them. */
export function itemActOffersOf(blocks: readonly CanonicalBlock[] | null | undefined): ItemActOffer[] {
  const out: ItemActOffer[] = [];
  for (const b of blocks ?? []) {
    if (b.type !== "tool" || b.toolCall?.name !== ITEM_ACT_TOOL || b.toolCall.isError) continue;
    if (b.toolCall.output === undefined) continue;
    const offer = readItemActOffer(toolOutputText(b.toolCall.output));
    if (offer) out.push(offer);
  }
  return out;
}

export interface Live {
  /** The item's state as its page reads it now; undefined until read. */
  state: string | undefined;
  loading: boolean;
  refetch: () => unknown;
}

type Label = ReturnType<typeof useLabel>;

const FAMILY = {
  requirement: "requirementState",
  feedback: "feedbackPhase",
  workflow: "designStatus",
  release: "releaseState",
} as const;

/** The state the press left the item in, read off the route's own answer (BC-5). */
function stateAfter(o: ItemActOffer, answer: unknown, L: Label): string | null {
  const a = answer as Record<string, unknown> | null;
  if (!a) return null;
  switch (itemActKind(o.act)) {
    case "requirement": {
      const rev = (a.revisions as { revision: number; state: string }[] | undefined)?.find((r) => r.revision === o.revision);
      const revisionAct = o.act === "requirement.propose" || o.act === "requirement.accept" || o.act === "requirement.return";
      if (revisionAct && rev) return `${o.revision ? `r${o.revision} ` : ""}${L("revisionState", rev.state)}`;
      return typeof a.status === "string" ? L("requirementState", a.status) : null;
    }
    case "feedback": {
      const phase = (a.feedback as { phase?: string } | undefined)?.phase;
      return phase ? L("feedbackPhase", phase) : null;
    }
    case "workflow":
      return typeof a.status === "string" ? L("designStatus", a.status) : null;
    case "release":
      if (typeof a.decision === "string") return L("releaseApproval", a.decision);
      return typeof a.version === "string" ? a.version : null;
  }
}

/** What the card says pressing it records: a decline says the reporter is told, another route where the item goes. */
const whatKey = (o: ItemActOffer): ProductCopyKey =>
  o.triage?.route === "decline" ? "conversations.itemAct.what.feedback.decline" : `conversations.itemAct.what.${o.act}`;

function hrefOf(slug: string, o: ItemActOffer): string {
  switch (itemActKind(o.act)) {
    case "requirement":
      return requirementHref(slug, o.key);
    case "feedback":
      return feedbackHref(slug, o.key);
    case "workflow":
      return workflowHref(slug, o.key);
    case "release":
      return releaseHref(slug, o.key);
  }
}

export function ItemActPress({
  offer,
  slug,
  live,
  press: run,
}: {
  offer: ItemActOffer;
  slug: string | undefined;
  live: Live;
  /** The route the item's page calls for the same act. */
  press: (o: ItemActOffer) => Promise<unknown>;
}) {
  const t = useCopy();
  const L = useLabel();
  const press = useMutation({ mutationFn: () => run(offer), onSettled: () => void live.refetch() });
  const family = FAMILY[itemActKind(offer.act)];
  const moved = !press.isSuccess && live.state !== undefined && live.state !== offer.from;
  const after = press.isSuccess ? stateAfter(offer, press.data, L) : null;
  const vars = {
    key: offer.key,
    revision: offer.revision ?? "",
    n: offer.issueKeys?.length ?? 0,
    route: offer.triage ? L("feedbackRoute", offer.triage.route) : "",
  };
  return (
    <div data-testid="item-act-offer" data-act={offer.act} className="flex flex-col gap-1.5 border-l-2 border-line py-1 pl-3">
      <p className="fg-body-sm font-semibold text-fg">
        {t(`conversations.itemAct.title.${offer.act}` as ProductCopyKey, vars)}
        {offer.title !== offer.key && <span className="font-normal text-muted"> · {offer.title}</span>}
      </p>
      <p className="fg-caption text-muted">
        {t(whatKey(offer), vars)} {t("conversations.act.yours")}
      </p>
      {offer.reason && <p className="fg-caption text-subtle">“{offer.reason}”</p>}
      {offer.triage?.note && <p className="fg-caption text-subtle">“{offer.triage.note}”</p>}
      {press.isSuccess ? (
        <p className="fg-caption flex items-center gap-1 text-fg" role="status" data-testid="item-act-done">
          <Icon name="check" size={12} />
          {after ? t("conversations.itemAct.now", { key: offer.key, state: after }) : t("conversations.act.done")}
        </p>
      ) : moved ? (
        <p className="fg-caption text-subtle" role="status">
          {t("conversations.act.moved", { key: offer.key, status: L(family, live.state as string) })}
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" variant={offer.act.endsWith(".drop") ? "danger" : "primary"} loading={press.isPending} disabled={live.loading} onClick={() => press.mutate()}>
            {t("conversations.act.confirm")}
          </Button>
        </div>
      )}
      {press.isError && (
        <div className="fg-caption flex flex-col gap-0.5" role="alert" data-testid="item-act-failed">
          <p className="text-danger">{formatApiError(press.error)}</p>
          <p className="text-muted">
            {t(`conversations.next.${nextStepOf(press.error)}` as ProductCopyKey)}{" "}
            {slug && (
              <Link href={hrefOf(slug, offer)} className="text-accent hover:underline">
                {t("conversations.itemAct.open", { key: offer.key })}
              </Link>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

