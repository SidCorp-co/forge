/**
 * A decision folded from a record on an issue (a suggestion, a mockup, a preview) reaches a person as
 * a decision on the product item the issue serves (REQ-68 BC-4, BC-6): the requirement it delivers,
 * else the feedback item it carries. It is listed under that item's area and opens that item, never
 * the issue. One on an issue serving neither is the master's, and no person's list holds it.
 * A record on a requirement, a feedback item or a workflow is listed on its own page.
 */

import type { NeedsYouAreaKey, NeedsYouEntity } from '@forge/contracts/needs-you';
import type { DecisionOpens } from '@forge/contracts/needs-you-decisions';
import type { readAttention } from './needs-you.js';

type Attention = Awaited<ReturnType<typeof readAttention>>;

/** The product item an issue serves, as a decision about it is listed. */
export interface IssueItem {
  area: Extract<NeedsYouAreaKey, 'requirements' | 'feedback'>;
  kind: Extract<NeedsYouEntity, 'requirement' | 'feedback'>;
  key: string;
  title: string;
}

/** Each open issue's item, by issue key, read from the issues, requirements and feedback already read. */
export function issueItemsOf(attention: Attention): (issueKey: string) => IssueItem | null {
  const reqTitle = new Map(attention.requirements.map((r) => [r.key, r.title]));
  const fbTitle = new Map(attention.feedback.map((f) => [f.key, f.title]));
  const items = new Map<string, IssueItem>();
  for (const i of attention.issues.issues) {
    const req = i.standing.requirement?.key;
    const fb = i.standing.feedback.find((k) => !i.standing.feedbackDropped.includes(k));
    if (req) {
      items.set(i.key, {
        area: 'requirements',
        kind: 'requirement',
        key: req,
        title: reqTitle.get(req) ?? req,
      });
    } else if (fb) {
      items.set(i.key, {
        area: 'feedback',
        kind: 'feedback',
        key: fb,
        title: fbTitle.get(fb) ?? fb,
      });
    }
  }
  return (issueKey) => items.get(issueKey) ?? null;
}

/** Where a folded decision is listed: its area, its row's entity, key and title, and the page it opens. */
export interface Placement {
  area: NeedsYouAreaKey;
  entity: NeedsYouEntity;
  key: string;
  title: string;
  opens: DecisionOpens;
}

const AREA_OF: Record<'requirement' | 'feedback' | 'workflow', NeedsYouAreaKey> = {
  requirement: 'requirements',
  feedback: 'feedback',
  workflow: 'designs',
};

/**
 * Where a record on `target` is listed: on the target's own page, or, for an issue, on the item it
 * serves, named by that item; null for an issue that serves none, which no person's list holds.
 */
export function placeOn(
  target: { type: 'requirement' | 'feedback' | 'workflow' | 'issue'; key: string; title: string },
  itemOf: (issueKey: string) => IssueItem | null,
): Placement | null {
  if (target.type !== 'issue') {
    const { type, key, title } = target;
    return { area: AREA_OF[type], entity: type, key, title, opens: { kind: type, key } };
  }
  const item = itemOf(target.key);
  if (!item) return null;
  return {
    area: item.area,
    entity: item.kind,
    key: item.key,
    title: item.title,
    opens: { kind: item.kind, key: item.key },
  };
}
