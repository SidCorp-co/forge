/**
 * The record the page beside the chat is about, loaded by core for the turn (REQ-30 BC-6, chat-turn
 * r2 step `context`). The browser names only the kind and the key its page is addressed by; what the
 * model reads of the record is read here, in the turn's own project, as the asker, and through the
 * egress surface its kind declares. A key that names nothing is said, never dropped: a turn told
 * nothing would answer about the project as though no page were open.
 */

import {
  describeUiSnapshot,
  type UiPageItem,
  type UiPageItemKind,
} from '@forge/contracts/ui-actions';
import { effectiveProjectRole } from '../lib/authz.js';
import { dataPolicyOf, type EgressSurface, egressAt } from '../lib/data-egress.js';
import { holds } from '../permissions/index.js';
import { approvalShown, releaseShown } from './page-item-decisions.js';
import {
  feedbackShown,
  issueShown,
  mockupShown,
  requirementShown,
  type Shown,
  workflowShown,
} from './page-item-shown.js';
import { latestUiSnapshot } from './ui-snapshot.js';

/** The surface each kind's content leaves through (`lib/data-egress.ts:EGRESS_SURFACES`). */
const SURFACE: Record<UiPageItemKind, EgressSurface> = {
  issue: 'issue',
  requirement: 'requirement',
  feedback: 'feedback',
  workflow: 'design',
  mockup: 'mockup.content',
  // a release reads as the issues it carries; a decision as the record it decides (`OPENS_SURFACE`)
  release: 'issue',
  approval: 'issue',
};

/** The surface a decision's words leave through: that of the record it opens. */
const OPENS_SURFACE: Record<string, EgressSurface> = {
  requirement: 'requirement',
  feedback: 'feedback',
  workflow: 'design',
};

export type LoadedPageItem =
  | ({ kind: UiPageItemKind; key: string; found: true } & Record<string, unknown>)
  | { kind: UiPageItemKind; key: string; found: false; reason: string };

function shownOf(projectId: string, item: UiPageItem, userId: string): Promise<Shown> {
  switch (item.kind) {
    case 'issue':
      return issueShown(projectId, item.key, userId);
    case 'requirement':
      return requirementShown(projectId, item.key);
    case 'feedback':
      return feedbackShown(projectId, item.key);
    case 'workflow':
      return workflowShown(projectId, item.key);
    case 'mockup':
      return mockupShown(projectId, item.key, userId);
    case 'release':
      return releaseShown(projectId, item.key, userId);
    case 'approval':
      return approvalShown(projectId, item.key, userId);
  }
}

/** The page's record as the turn reads it: found within the asker's read, or why it is not there. */
export async function loadPageItem(
  projectId: string,
  userId: string,
  item: UiPageItem,
): Promise<LoadedPageItem> {
  const access = await effectiveProjectRole(userId, projectId);
  if (!access || !holds(access, 'project.read')) {
    return {
      kind: item.kind,
      key: item.key,
      found: false,
      reason: `the asker may not read project ${projectId}, so ${item.key} was not loaded`,
    };
  }
  const shown = await shownOf(projectId, item, userId);
  if (!shown) {
    return {
      kind: item.kind,
      key: item.key,
      found: false,
      reason: `this project holds no ${item.kind} ${item.key}: the page names a record the turn could not find`,
    };
  }
  const level = await dataPolicyOf(projectId);
  const opens = (shown.meta.opens as { kind?: string } | null | undefined)?.kind;
  const surface = (item.kind === 'approval' && opens && OPENS_SURFACE[opens]) || SURFACE[item.kind];
  const out = egressAt(level, surface, shown.content, `${item.kind} ${shown.key}`);
  // the metadata stays at every level; the content the policy keeps in is said withheld, not sent
  const content = out.ok ? out.value : { withheld: out.refusal.detail };
  return { ...shown.meta, ...content, kind: item.kind, key: shown.key, found: true };
}

/**
 * The page the person was on at their newest message, as the turn's page context, with the record
 * it is about loaded; null where the browser sent no snapshot. Both modes read this one object.
 */
export async function turnPageContext(args: {
  conversationId: string;
  projectId: string;
  userId: string;
}): Promise<Record<string, unknown> | null> {
  const snapshot = latestUiSnapshot(args.conversationId);
  if (!snapshot) return null;
  const base = { sees: describeUiSnapshot(snapshot), snapshot };
  if (!snapshot.item) return base;
  const item = await loadPageItem(args.projectId, args.userId, snapshot.item);
  return {
    ...base,
    about: `The person has ${item.kind} ${item.key} open beside the chat. "This", "here" and "it" mean that ${item.kind} unless they name another; answer about it by its key, and read it with your tools before saying what it holds.`,
    item,
  };
}
