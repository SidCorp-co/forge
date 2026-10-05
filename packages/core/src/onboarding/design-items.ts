/**
 * project-onboarding `designs`, `answer-lands`, `revise` and `what-next`, as pure functions: which
 * questionnaire items shaped each onboarding design, which of them stay open as the design's open
 * questions once every round is sent, and the guards on an update citing the items its revisions
 * and suggestions came from.
 */

import {
  type OnboardingCite,
  type OnboardingLinkedItem,
  type OnboardingRefusal,
  QUESTIONNAIRE_MAX_ROUNDS,
  type QuestionnaireItem,
  type QuestionnaireItemState,
} from '@forge/contracts/onboarding';
import type { QuestionnaireLanding } from '../db/schema-questions.js';

/** One item row of the onboarding's current series, as read from agent_questions. */
export interface SeriesItem {
  questionId: string;
  round: number;
  createdAt: Date;
  state: QuestionnaireItemState;
  /** The accept / reject decision of an answered recommendation. */
  decision: 'accept' | 'reject' | null;
  item: QuestionnaireItem;
  landedIn: readonly QuestionnaireLanding[] | null;
}

export interface DesignKey {
  workflowId: string;
  flow: string;
  revision: number;
}

/** Each item id's latest row: a follow-up round re-asks an open item under the same id. */
export function latestPerItem(items: readonly SeriesItem[]): SeriesItem[] {
  const out = new Map<string, SeriesItem>();
  for (const it of items) {
    const had = out.get(it.item.id);
    if (
      !had ||
      it.round > had.round ||
      (it.round === had.round && it.createdAt.getTime() > had.createdAt.getTime())
    )
      out.set(it.item.id, it);
  }
  return [...out.values()];
}

const citedRevisionOf = (it: SeriesItem, workflowId: string): number | null => {
  const revs = (it.landedIn ?? []).flatMap((l) =>
    'workflowId' in l && l.workflowId === workflowId ? [l.revision] : [],
  );
  return revs.length ? Math.max(...revs) : null;
};

// an item links to a design when its `affects` names the design (by id or flow) or an
// update cited it from one of the design's revisions; once all rounds are sent, the linked items
// still open are the design's open questions, read from the item rows and never written anywhere
export function linkItems(
  design: Pick<DesignKey, 'workflowId' | 'flow'>,
  items: readonly SeriesItem[],
  roundsSent: number,
): { linkedItems: OnboardingLinkedItem[]; openQuestions: OnboardingLinkedItem[] } {
  const linkedItems = latestPerItem(items)
    .filter((it) => it.state !== 'void')
    .flatMap((it): OnboardingLinkedItem[] => {
      const citedRevision = citedRevisionOf(it, design.workflowId);
      const affects =
        it.item.affects.includes(design.workflowId) || it.item.affects.includes(design.flow);
      if (!affects && citedRevision === null) return [];
      return [
        {
          itemId: it.item.id,
          questionId: it.questionId,
          group: it.item.group,
          prompt: it.item.prompt,
          state: it.state,
          citedRevision,
        },
      ];
    });
  const openQuestions =
    roundsSent >= QUESTIONNAIRE_MAX_ROUNDS ? linkedItems.filter((i) => i.state === 'open') : [];
  return { linkedItems, openQuestions };
}

// an update cites only items of this onboarding's current series (QUESTIONNAIRE_ITEM_UNKNOWN)
// that a person answered (ONBOARDING_CITE_UNANSWERED: an inferred default is never applied
// silently), never a rejected recommendation (QUESTIONNAIRE_RECOMMENDATION_REJECTED), from a
// design of the onboarding (ONBOARDING_DESIGN_UNKNOWN) at a revision it holds
// (ONBOARDING_CITE_REVISION_UNKNOWN), one revision per design per update
// (ONBOARDING_CITE_REVISION_TWICE), or from a suggestion of the project
// (ONBOARDING_CITE_SUGGESTION_UNKNOWN)
export function citeRefusals(
  cites: readonly OnboardingCite[],
  items: readonly SeriesItem[],
  designs: readonly DesignKey[],
  suggestionIds: ReadonlySet<string>,
): OnboardingRefusal[] {
  const out: OnboardingRefusal[] = [];
  const byItem = new Map(latestPerItem(items).map((it) => [it.item.id, it]));
  const byDesign = new Map(designs.map((d) => [d.workflowId, d]));
  const revisionOf = new Map<string, number>();
  cites.forEach((c, i) => {
    const at = `/cites/${i}`;
    const it = byItem.get(c.itemId);
    if (!it) {
      out.push({
        code: 'QUESTIONNAIRE_ITEM_UNKNOWN',
        path: `${at}/itemId`,
        detail: `this onboarding asked no item "${c.itemId}" since its last start or re-analysis; its items are ${[...byItem.keys()].join(', ') || 'none'}.`,
      });
      return;
    }
    if (it.state !== 'answered') {
      out.push({
        code: 'ONBOARDING_CITE_UNANSWERED',
        path: `${at}/itemId`,
        detail: `"${c.itemId}" is ${it.state}: only an answered item lands on a design, and an inferred default is never applied for an unanswered one. Leave it open; it is asked again or listed as an open question.`,
      });
      return;
    }
    if (it.decision === 'reject') {
      out.push({
        code: 'QUESTIONNAIRE_RECOMMENDATION_REJECTED',
        path: `${at}/itemId`,
        detail: `"${c.itemId}" was rejected; a rejected recommendation is recorded on the item and lands nowhere.`,
      });
      return;
    }
    if ('suggestionId' in c) {
      if (!suggestionIds.has(c.suggestionId))
        out.push({
          code: 'ONBOARDING_CITE_SUGGESTION_UNKNOWN',
          path: `${at}/suggestionId`,
          detail: `this project holds no suggestion ${c.suggestionId}; write it first (POST …/suggestions), then cite it.`,
        });
      return;
    }
    const d = byDesign.get(c.workflowId);
    if (!d) {
      out.push({
        code: 'ONBOARDING_DESIGN_UNKNOWN',
        path: `${at}/workflowId`,
        detail: `workflow ${c.workflowId} is not a design of this onboarding; name it in this update's designs.workflowIds, or cite one of ${designs.map((x) => x.workflowId).join(', ') || 'none'}.`,
      });
      return;
    }
    if (c.revision > d.revision) {
      out.push({
        code: 'ONBOARDING_CITE_REVISION_UNKNOWN',
        path: `${at}/revision`,
        detail: `${d.flow} stands at revision ${d.revision}; write the revision (PUT …/workflows/${d.workflowId}) before citing it.`,
      });
      return;
    }
    const had = revisionOf.get(c.workflowId);
    if (had !== undefined && had !== c.revision) {
      out.push({
        code: 'ONBOARDING_CITE_REVISION_TWICE',
        path: `${at}/revision`,
        detail: `this update already cites ${d.flow} revision ${had}; one revision per design per submit carries every item that shaped it.`,
      });
      return;
    }
    revisionOf.set(c.workflowId, c.revision);
  });
  return out;
}

/** The landings each cited item gains, keyed by question id; a landing already recorded is kept once. */
export function landingsOf(
  cites: readonly OnboardingCite[],
  items: readonly SeriesItem[],
  by: string,
  at: Date,
): Map<string, QuestionnaireLanding[]> {
  const byItem = new Map(latestPerItem(items).map((it) => [it.item.id, it]));
  const out = new Map<string, QuestionnaireLanding[]>();
  const key = (l: QuestionnaireLanding) =>
    'workflowId' in l ? `w:${l.workflowId}:${l.revision}` : `s:${l.suggestionId}`;
  for (const c of cites) {
    const it = byItem.get(c.itemId);
    if (!it) continue;
    const list = out.get(it.questionId) ?? [...(it.landedIn ?? [])];
    const landing: QuestionnaireLanding =
      'suggestionId' in c
        ? { suggestionId: c.suggestionId, by, at: at.toISOString() }
        : { workflowId: c.workflowId, revision: c.revision, by, at: at.toISOString() };
    if (!list.some((l) => key(l) === key(landing))) list.push(landing);
    out.set(it.questionId, list);
  }
  return out;
}
