// The Product acts the assistant offers on an item (`offer_item_act`, REQ-69 BC-3), adapted to each
// item kind: the press runs as the person through the item page's own route, and the card reads the
// item's state the way that page reads it. The card itself is `item-act-card.tsx`.

import { type ItemActOffer, itemActKind } from "@forge/contracts/item-acts";
import { feedbackApi, useFeedbackItem } from "@/features/feedback";
import { releasesApi, useRelease } from "@/features/releases";
import { requirementsApi, useRequirement } from "@/features/requirements";
import { useWorkflowDesign, workflowsApi } from "@/features/workflows";
import { ItemActPress } from "./item-act-card";

/** A field the act needs and the offer lacks: refused by name, never sent without it. */
function needs<T>(value: T | undefined, field: string, o: ItemActOffer): T {
  if (value === undefined) throw new Error(`the ${o.act} card on ${o.key} names no ${field}`);
  return value;
}

/** What pressing the card calls: the route the item's page uses for the same act. */
export function pressItemAct(o: ItemActOffer): Promise<unknown> {
  const reason = o.reason;
  const why = () => needs(reason, "reason", o);
  const revision = () => needs(o.revision, "revision", o);
  const req = (a: Parameters<typeof requirementsApi.act>[2]) => requirementsApi.act(o.projectId, o.ref, a);
  const given = reason ? { reason } : {};
  switch (o.act) {
    case "requirement.propose":
      return req({ kind: "propose", revision: revision() });
    case "requirement.agree":
      return req({ kind: "agree", revision: revision(), ...given });
    case "requirement.accept":
      return req({ kind: "accept", revision: revision(), ...given });
    case "requirement.return":
      return req({ kind: "return", revision: revision(), reason: why() });
    case "requirement.defer":
      return req({ kind: "defer", reason: why() });
    case "requirement.undefer":
      return req({ kind: "undefer", reason: why() });
    case "requirement.drop":
      return req({ kind: "drop", reason: why() });
    case "requirement.accept_delivery":
      return req({ kind: "accept-delivery", revision: revision(), ...given });
    case "feedback.triage":
      return feedbackApi.act(o.projectId, o.ref, { kind: "triage", triage: needs(o.triage, "triage", o) as never });
    case "workflow.propose":
      return workflowsApi.propose(o.projectId, o.ref, revision());
    case "workflow.approve":
      return workflowsApi.decide(o.projectId, o.ref, { revision: revision(), decision: "approve", ...given });
    case "workflow.return":
      return workflowsApi.decide(o.projectId, o.ref, { revision: revision(), decision: "return", reason: why() });
    case "release.cut":
      return releasesApi.cut(o.projectId, needs(o.issueIds, "issues", o));
    case "release.approve":
    case "release.return":
      return releasesApi.decide(o.projectId, needs(o.runId, "release run", o), needs(o.approvalId, "approval", o), {
        decision: o.act === "release.approve" ? "approve" : "return",
        reason: why(),
      });
  }
}

function RequirementActPress({ offer, slug }: { offer: ItemActOffer; slug: string | undefined }) {
  const q = useRequirement(offer.projectId, offer.ref);
  return <ItemActPress press={pressItemAct} offer={offer} slug={slug} live={{ state: q.data?.status, loading: q.isLoading, refetch: q.refetch }} />;
}

function FeedbackActPress({ offer, slug }: { offer: ItemActOffer; slug: string | undefined }) {
  const q = useFeedbackItem(offer.projectId, offer.ref);
  return <ItemActPress press={pressItemAct} offer={offer} slug={slug} live={{ state: q.data?.feedback.phase, loading: q.isLoading, refetch: q.refetch }} />;
}

function WorkflowActPress({ offer, slug }: { offer: ItemActOffer; slug: string | undefined }) {
  const q = useWorkflowDesign(offer.projectId, offer.ref);
  const state = q.data ? (q.data.status ?? "draft") : undefined;
  return <ItemActPress press={pressItemAct} offer={offer} slug={slug} live={{ state, loading: q.isLoading, refetch: q.refetch }} />;
}

function ReleaseActPress({ offer, slug }: { offer: ItemActOffer; slug: string | undefined }) {
  const q = useRelease(offer.projectId, offer.ref);
  return <ItemActPress press={pressItemAct} offer={offer} slug={slug} live={{ state: q.data?.release.state, loading: q.isLoading, refetch: q.refetch }} />;
}

/** One card, reading its item's state the way that item's page reads it. */
export function ItemActOfferNotice({ offer, slug }: { offer: ItemActOffer; slug: string | undefined }) {
  switch (itemActKind(offer.act)) {
    case "requirement":
      return <RequirementActPress offer={offer} slug={slug} />;
    case "feedback":
      return <FeedbackActPress offer={offer} slug={slug} />;
    case "workflow":
      return <WorkflowActPress offer={offer} slug={slug} />;
    case "release":
      return <ReleaseActPress offer={offer} slug={slug} />;
  }
}
