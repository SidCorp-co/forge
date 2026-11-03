// The home's rows as pure reads of what core served (ISS-919): what waits on the person, in the
// order the needs-you read gives it (decisions first), and the place each act is taken. The screen
// renders these; it counts, merges and filters nothing of its own.

import type { NeedsYouDecision } from "@forge/contracts/needs-you-decisions";
import type { useAttention } from "@/features/attention";
import { decisionHref } from "@/features/needs-you";
import { approvalsHref, questionDecisionHref } from "@/lib/routes/approvals";
import { feedbackHref } from "@/lib/routes/feedback";
import { issuesHref } from "@/lib/routes/issues";
import type { LegendTone } from "@/design";
import type { HomeMovingItem, HomeStage } from "./types";

type AttentionView = NonNullable<ReturnType<typeof useAttention>["view"]>;

/** The act a waiting row asks for: the button's word. */
export type WaitingAct = "answer" | "approve" | "review";
/** What a waiting row is, in one to three words. */
export type WaitingKind = "question" | "approval" | "delivery" | "fixCheck" | "gate" | "mention";

export interface WaitingRow {
  id: string;
  title: string;
  /** Its key, for the tooltip only. */
  tip: string | null;
  projectName: string;
  kind: WaitingKind;
  act: WaitingAct;
  href: string;
}

const DECISION_KIND: Record<NeedsYouDecision["group"], WaitingKind> = {
  answer: "question",
  approve: "approval",
  accept: "delivery",
  verify: "fixCheck",
};
const DECISION_ACT: Record<NeedsYouDecision["group"], WaitingAct> = {
  answer: "answer",
  approve: "approve",
  accept: "review",
  verify: "review",
};

function decisionPlace(slug: string, d: NeedsYouDecision): string {
  if (d.entity === "question") return questionDecisionHref(slug, d.key);
  return decisionHref(slug, d.opens) ?? approvalsHref(slug);
}

/** Every row waiting on the person: each project's decisions first, then gates, then mentions. */
export function waitingRows(view: AttentionView): WaitingRow[] {
  const decisions = view.needsYou.flatMap((part) =>
    part.decisions.map(
      (d): WaitingRow => ({
        id: `${part.projectSlug}:${d.id}`,
        title: d.title || d.question,
        tip: d.entity === "question" ? null : d.key,
        projectName: part.projectName,
        kind: DECISION_KIND[d.group],
        act: DECISION_ACT[d.group],
        href: decisionPlace(part.projectSlug, d),
      }),
    ),
  );
  const gates = view.channelGates.map(
    (g): WaitingRow => ({
      id: `gate:${g.link}`,
      title: g.title,
      tip: g.documentNumber ?? null,
      projectName: g.projectName ?? "",
      kind: "gate",
      act: "approve",
      href: g.link,
    }),
  );
  const mentions = view.mentions.map(
    (m): WaitingRow => ({
      id: `mention:${m.link}:${m.since}`,
      title: m.title,
      tip: m.issueRef ?? null,
      projectName: m.projectName ?? "",
      kind: "mention",
      act: "review",
      href: m.link,
    }),
  );
  return [...decisions, ...gates, ...mentions];
}

/** The page an item opens on: an issue in the list's peek, a feedback item on its page. */
export function itemHref(item: Pick<HomeMovingItem, "kind" | "key" | "projectSlug">): string {
  return item.kind === "issue"
    ? `${issuesHref(item.projectSlug)}?peek=${encodeURIComponent(item.key)}`
    : feedbackHref(item.projectSlug, item.key);
}

/** A stage's tone in the status legend. */
export const STAGE_TONE: Record<HomeStage, LegendTone> = {
  new: "neutral",
  planned: "ready",
  building: "run",
  landed: "done",
  releasing: "run",
};

/** Rows a section shows before its "show more": the first screen stays within the page's word budget. */
export const HOME_ROWS = 3;
