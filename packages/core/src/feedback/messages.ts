/**
 * Messages from a feedback item. To reporters: pick the audience (this reporter, or every reporter
 * merged into the item), preview the exact notice, send; it is one `feedback.reporterTold` event, the
 * same text the preview showed. An internal note is a row for project members and nothing else: it
 * emits no event, and its row cannot hold a recipient (feedback_messages_internal_chk).
 */

import type {
  FeedbackMessageAudience,
  FeedbackMessagePreview,
  FeedbackView,
} from '@forge/contracts/feedback';
import { feedbackKey } from '@forge/contracts/feedback';
import type { WrittenLang } from '@forge/contracts/written-lang';
import { db, type Tx } from '../db/client.js';
import { feedbackMessages } from '../db/schema-feedback.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { userNames } from '../lib/people.js';
import type { Refusal } from '../lib/refusal.js';
import { writtenLangFor } from '../lib/written-lang.js';
import { emitEvent } from '../outbox/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type FeedbackActor, type Row, rowIn } from './read.js';
import { messageNotice } from './reporter-notices.js';
import { type Reporter, reportersOf, withBell } from './reporters.js';
import { decideActRefusal } from './rules.js';
import { answer, inTx, lockFeedback, roleFacts } from './service.js';
import { messageRefusal, noteActRefusal } from './verb-rules.js';

type ToReporters = Exclude<FeedbackMessageAudience, 'internal'>;

const audienceOf = (all: Reporter[], audience: ToReporters): Reporter[] =>
  audience === 'reporter' ? all.slice(0, 1) : all;

async function plan(tx: Tx, row: Row, audience: ToReporters, text: string) {
  const level = await dataPolicyOf(row.projectId);
  const said = storedText(level, text.trim()).text;
  const addressed = audienceOf(await reportersOf(tx, row), audience);
  const reached = withBell(addressed);
  const notice = messageNotice(feedbackKey(row.fbSeq), row.title, said);
  return { addressed, reached, notice, said };
}

async function previewOf(
  tx: Tx,
  row: Row,
  audience: ToReporters,
  text: string,
): Promise<{ preview: FeedbackMessagePreview } | { refusal: Refusal }> {
  const p = await plan(tx, row, audience, text);
  const refused = messageRefusal(audience, p.said, p.reached.length);
  if (refused) return { refusal: refused };
  const names = await userNames(p.addressed.map((r) => r.id));
  const nameOf = (id: string) => names.get(id) ?? null;
  return {
    preview: {
      audience,
      title: p.notice.title,
      body: p.notice.body,
      recipients: p.reached.map((r) => ({ id: r.id, name: nameOf(r.id) })),
      notReached: p.addressed
        .filter((r) => r.agency !== 'human')
        .map((r) => ({
          id: r.id,
          name: nameOf(r.id),
          why: 'An agent reporter has no bell; tell it where it listens.',
        })),
    },
  };
}

/** The exact notice a send would deliver and who would get it, written nowhere. */
export async function previewMessage(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  audience: ToReporters;
  text: string;
}): Promise<{ ok: true; preview: FeedbackMessagePreview } | { ok: false; refusals: Refusal[] }> {
  const { projectId, actor } = input;
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const forbidden = decideActRefusal(await roleFacts(actor, projectId), 'messaging reporters');
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const row = await rowIn(db, projectId, input.ref);
  const out = await previewOf(db, row, input.audience, input.text);
  return 'refusal' in out ? { ok: false, refusals: [out.refusal] } : { ok: true, ...out };
}

/** Sends a message to reporters, or writes an internal note; answers the item as it reads next. */
export async function sendMessage(input: {
  projectId: string;
  ref: string;
  actor: FeedbackActor;
  audience: FeedbackMessageAudience;
  text: string;
  writtenLang?: WrittenLang | undefined;
}): Promise<{ ok: true; feedback: FeedbackView } | { ok: false; refusals: Refusal[] }> {
  const { projectId, actor, audience } = input;
  const writtenLang = await writtenLangFor(
    actor,
    projectId,
    input.writtenLang,
    undefined,
    input.text,
  );
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const facts = await roleFacts(actor, projectId);
  const forbidden =
    audience === 'internal'
      ? noteActRefusal(facts)
      : decideActRefusal(facts, 'messaging reporters');
  if (forbidden) return { ok: false, refusals: [forbidden] };
  const first = await rowIn(db, projectId, input.ref);
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    const row = await rowIn(tx, projectId, first.id, true);
    if (audience === 'internal') {
      const level = await dataPolicyOf(projectId);
      const note = storedText(level, input.text.trim()).text;
      const refused = messageRefusal('internal', note, 0);
      if (refused) return [refused];
      await tx.insert(feedbackMessages).values({
        projectId,
        feedbackId: row.id,
        audience,
        body: note,
        recipients: [],
        sentBy: actor.userId,
        sentAgency: actor.agency,
        writtenLang,
      });
      return null;
    }
    const p = await plan(tx, row, audience, input.text);
    const refused = messageRefusal(audience, p.said, p.reached.length);
    if (refused) return [refused];
    const recipients = p.reached.map((r) => r.id);
    await tx.insert(feedbackMessages).values({
      projectId,
      feedbackId: row.id,
      audience,
      body: p.said,
      recipients,
      sentBy: actor.userId,
      sentAgency: actor.agency,
      writtenLang,
    });
    await emitEvent(tx, 'feedback.reporterTold', {
      projectId,
      feedbackId: row.id,
      kind: 'message',
      recipients,
      title: p.notice.title,
      body: p.notice.body,
    });
    return null;
  });
  if (refusals) return { ok: false, refusals };
  const out = await answer(projectId, first.id, actor);
  return out.ok ? { ok: true, feedback: out.feedback } : out;
}
