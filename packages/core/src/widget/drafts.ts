/**
 * A draft the widget's assistant proposed, and the visitor's two acts on it. Only the visitor's own
 * session files one: confirming it files exactly one Feedback item on the binding's project, as the
 * binding's own account, with the visitor as its external reporter and the page they were on as
 * data, and hands them a private status link. Discarding it files nothing.
 */

import { FEEDBACK_LIMITS } from '@forge/contracts/feedback';
import {
  type WidgetFeedbackDraft,
  type WidgetFiled,
  type WidgetPageContext,
  widgetPageContextSchema,
} from '@forge/contracts/widget';
import type { WidgetDraftParams } from '../assistant/index.js';
import { type ExternalReporter, fileExternalFeedback } from '../feedback/index.js';
import type { WidgetBinding } from '../integrations/widget/index.js';
import { publishWidgetEvent } from './events.js';
import { widgetPrincipalFor } from './principal.js';
import { refuse } from './refuse.js';
import {
  type DraftRow,
  discardPendingDraft,
  draftOfSession,
  draftView,
  lockPendingDraft,
  markDraftFiled,
  replacePendingDraft,
  type SessionRow,
} from './store.js';
import { mintStatusToken, sealStatusToken, statusUrlOf } from './tokens.js';

/** Store what the assistant proposed, replacing the draft that waited, and show the visitor both. */
export async function proposeDraft(
  session: Pick<SessionRow, 'id' | 'projectId' | 'conversationId'>,
  draft: WidgetDraftParams,
): Promise<{ draftId: string }> {
  const stored = await replacePendingDraft(session, {
    kind: draft.kind,
    title: draft.title,
    did: draft.did ?? null,
    saw: draft.saw,
    expected: draft.expected ?? null,
    whereSeen: draft.whereSeen ?? null,
  });
  for (const gone of stored.discarded) {
    publishWidgetEvent(session.conversationId, { type: 'draft', draft: draftView(gone) });
  }
  publishWidgetEvent(session.conversationId, { type: 'draft', draft: draftView(stored.draft) });
  return { draftId: stored.draft.id };
}

const notPending = (draftId: string, row: DraftRow | null) =>
  refuse(
    'WIDGET_DRAFT_NOT_PENDING',
    row
      ? `draft ${draftId} was already ${row.state}; only a draft still waiting on you can be sent or discarded`
      : `this session holds no draft ${draftId}`,
    '/draftId',
  );

const PAGE_LABELS: Readonly<Record<string, string>> = {
  url: 'Page',
  title: 'Page title',
  productId: 'Product',
  appVersion: 'App version',
  locale: 'Locale',
  userAgent: 'Browser',
};

/** The item's body: the visitor's account in three parts, then where they were, all as data. */
export function feedbackBodyOf(
  draft: Pick<DraftRow, 'did' | 'saw' | 'expected'>,
  page: WidgetPageContext | null,
  site: string,
): string {
  const account = [
    draft.did ? `What they did: ${draft.did}` : null,
    `What they saw: ${draft.saw}`,
    draft.expected ? `What they expected: ${draft.expected}` : null,
  ].filter((line): line is string => line !== null);
  const where = page
    ? [
        ...Object.entries(PAGE_LABELS).flatMap(([key, label]) => {
          const value = page[key as keyof WidgetPageContext];
          return typeof value === 'string' ? [`${label}: ${value}`] : [];
        }),
        ...Object.entries(page.extra ?? {}).map(([key, value]) => `${key}: ${value}`),
      ]
    : [];
  return [
    account.join('\n'),
    [`Reported by a visitor through the feedback widget on ${site}.`, ...where].join('\n'),
  ].join('\n\n');
}

const pageOf = (raw: unknown): WidgetPageContext | null => {
  const parsed = widgetPageContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

export async function confirmDraft(
  session: SessionRow,
  binding: WidgetBinding,
  draftId: string,
): Promise<WidgetFiled> {
  const draft = await draftOfSession(session.id, draftId);
  if (draft?.state !== 'pending') throw notPending(draftId, draft);
  const page = pageOf(session.pageContext);
  const status = mintStatusToken();
  const reporter: ExternalReporter = {
    channel: 'widget',
    bindingId: binding.bindingId,
    visitorId: session.visitorId,
    email: session.visitorEmail,
    name: session.visitorName,
    signedUserId: session.signedUserId,
    pageContext: page,
    statusTokenHash: status.hash,
  };
  const site = binding.config.title ?? 'the client site';
  // an item is about one target: a visitor's is the screen they saw it on, named in words
  const screen = (draft.whereSeen ?? page?.url ?? `${site} (no page named)`)
    .slice(0, FEEDBACK_LIMITS.whereSeen)
    .trim();
  const filed = await fileExternalFeedback({
    projectId: session.projectId,
    filedAs: await widgetPrincipalFor({
      bindingId: binding.bindingId,
      projectId: binding.projectId,
      title: binding.config.title,
    }),
    request: {
      kind: draft.kind,
      title: draft.title,
      body: feedbackBodyOf(draft, page, site),
      screen,
    },
    reporter,
    dedupKey: `widget-draft:${draft.id}`,
    within: {
      // the draft is taken under the same lock as the item: of two confirms, the second finds it filed
      before: async (tx) => {
        const held = await lockPendingDraft(tx, draft.id);
        return held
          ? null
          : (notPending(draftId, { ...draft, state: 'filed' }).refusals[0] ?? null);
      },
      after: (tx, item) =>
        markDraftFiled(tx, draft.id, {
          feedbackId: item.id,
          feedbackKey: item.key,
          statusTokenEnc: sealStatusToken(status.token),
        }),
    },
  });
  if (!filed.ok) {
    const first = filed.refusals[0];
    if (first?.code === 'WIDGET_DRAFT_NOT_PENDING')
      throw notPending(draftId, await draftOfSession(session.id, draftId));
    throw refuse(
      'WIDGET_REFUSED',
      `this report could not be filed: ${filed.refusals.map((r) => `${r.code} ${r.detail}`).join('; ')}`,
    );
  }
  const statusUrl = statusUrlOf(status.token);
  const view = await draftOfSession(session.id, draftId);
  if (view) publishWidgetEvent(session.conversationId, { type: 'draft', draft: draftView(view) });
  publishWidgetEvent(session.conversationId, {
    type: 'filed',
    draftId,
    feedbackKey: filed.key,
    statusUrl,
  });
  return { feedbackKey: filed.key, statusUrl };
}

export async function discardDraft(
  session: SessionRow,
  draftId: string,
): Promise<WidgetFeedbackDraft> {
  const discarded = await discardPendingDraft(session.id, draftId);
  if (!discarded) throw notPending(draftId, await draftOfSession(session.id, draftId));
  const view = draftView(discarded);
  publishWidgetEvent(session.conversationId, { type: 'draft', draft: view });
  return view;
}
