/**
 * A report made from any page (REQ-66 BC-1): one sentence and a screenshot, filed into the project as
 * the person who made it. The agent reads the sentence for its kind and severity and names the open
 * item it repeats; a repeat joins that item as an occurrence, with what was said and the screenshot,
 * and never becomes an item of its own (BC-3). The target is the page it was seen on: the requirement
 * or issue that page shows, else the page itself. On a project that redacts, the sentence reaches the
 * agent scrubbed and the screenshot not at all until the reporter marks it redacted (BC-7); at
 * no_egress the agent reads neither, so the reporter names the kind (`FEEDBACK_KIND_NEEDED`).
 */

import { randomUUID } from 'node:crypto';
import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import {
  FEEDBACK_REPORT_KINDS,
  FEEDBACK_SEVERITIES,
  type FeedbackReportRequest,
  type FeedbackReportResponse,
  feedbackKey,
} from '@forge/contracts/feedback';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { callFastModelObject } from '../integrations/llm/index.js';
import { embedText, nearestItems } from '../knowledge/index.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import type { Refusal } from '../lib/refusal.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import {
  type CheckedAttachment,
  checkedAttachment,
  dropStored,
  insertAttachmentIn,
  storedAttachment,
} from './attachments.js';
import { embedFeedbackLater } from './embeddings.js';
import { linkedOf, phaseIn } from './list-read.js';
import { addOccurrenceIn } from './occurrences.js';
import { type FeedbackActor, type Row, rowIn } from './read.js';
import { answer, insertFeedbackIn, inTx, lockFeedback, preparedFeedback } from './service.js';

/** The phases an item is closed at: a repeat of it is a new item, not an occurrence. */
const CLOSED: readonly string[] = ['verified', 'declined'];
/** The open items nearest the sentence the agent is shown to judge a repeat against. */
const CANDIDATES = 3;

export type ReportOutcome =
  | ({ ok: true } & FeedbackReportResponse)
  | { ok: false; refusals: Refusal[] };

/** What the agent answers of one report. */
const readingSchema = z.object({
  kind: z.enum(FEEDBACK_REPORT_KINDS),
  severity: z.enum(FEEDBACK_SEVERITIES),
  /** The key of the open item this report repeats, or null where it repeats none. */
  sameAs: z.string().nullable(),
});
type Reading = z.infer<typeof readingSchema>;

/** The requirement or issue a page shows, by the key in its path; else the page is the target. */
export function targetOfPage(
  whereSeen: string,
): { requirement: string } | { issue: string } | { screen: string } {
  const path = whereSeen.split(/[?#]/)[0] ?? whereSeen;
  const req = /\/requirements\/(REQ-\d+)(?:\/|$)/i.exec(path)?.[1];
  if (req) return { requirement: req.toUpperCase() };
  const iss = /\/issues\/([A-Z][A-Z0-9]*-\d+)(?:\/|$)/i.exec(path)?.[1];
  if (iss) return { issue: iss.toUpperCase() };
  return { screen: whereSeen };
}

/** The item a repeat of `row` joins: its root where it is a duplicate; null where that is closed or redacted. */
async function openRootIn(exec: Tx | typeof db, projectId: string, row: Row): Promise<Row | null> {
  let item = row;
  if (row.duplicateOf) {
    const [root] = await exec.select().from(feedback).where(eq(feedback.id, row.duplicateOf));
    if (!root) return null;
    item = root;
  }
  if (item.redactedAt) return null;
  return CLOSED.includes(phaseIn(item, await linkedOf(projectId, [item]))) ? null : item;
}

/** The open items nearest the sentence by stored vector; none where the policy or provider embeds nothing. */
async function candidatesOf(projectId: string, said: string): Promise<Row[]> {
  const own = await embedText(projectId, 'feedback', said, 'the feedback report');
  if (own.status !== 'embedded') return [];
  const near = await nearestItems({
    projectId,
    kind: 'feedback',
    vector: own.vector,
    model: own.model,
    limit: CANDIDATES * 2,
  });
  if (near.length === 0) return [];
  const rows = await db
    .select()
    .from(feedback)
    .where(
      inArray(
        feedback.id,
        near.map((n) => n.itemId),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const open = new Map<string, Row>();
  for (const n of near) {
    const row = byId.get(n.itemId);
    const root = row ? await openRootIn(db, projectId, row) : null;
    if (root && !open.has(root.id)) open.set(root.id, root);
  }
  return [...open.values()].slice(0, CANDIDATES);
}

function readingPrompt(said: string, whereSeen: string, candidates: readonly Row[]): string {
  const open = candidates.length
    ? candidates.map((c) => `- ${feedbackKey(c.fbSeq)}: ${c.title}`).join('\n')
    : '(none)';
  return [
    'A person reported feedback about a product in one sentence, on the page named below.',
    `Kinds: bug (something is broken), change_request (something should work differently), question, idea.`,
    `Severities: low, medium, high, critical (critical: work stops or data is lost; high: a main task fails; low: cosmetic).`,
    'Open items that may already say the same thing are listed. Name one as sameAs only where it is the same problem on the same thing, else null.',
    '',
    `Page: ${whereSeen}`,
    `Sentence: ${said}`,
    'Open items:',
    open,
  ].join('\n');
}

/** Why the agent did not read a report, as the refusal says it to the reporter. */
const MISSED: Record<string, string> = {
  withheld:
    'this project keeps feedback from models, so the agent could not read the sentence for its kind',
  unconfigured: 'no model is set up to read the sentence for its kind',
};

async function readingOf(
  projectId: string,
  said: string,
  whereSeen: string,
  candidates: readonly Row[],
): Promise<{ ok: true; reading: Reading } | { ok: false; why: string }> {
  const answered = await callFastModelObject(
    { surface: 'feedback', projectId, what: 'the feedback report' },
    readingPrompt(said, whereSeen, candidates),
    readingSchema,
    { maxTokens: 200 },
  );
  if (answered.ok) return { ok: true, reading: answered.value };
  return {
    ok: false,
    why: MISSED[answered.miss] ?? `the agent could not read the sentence (${answered.miss})`,
  };
}

/** Where the report goes: the open item it repeats, or a new one, with its kind and severity. */
async function placeOf(
  projectId: string,
  request: FeedbackReportRequest,
): Promise<
  | {
      ok: true;
      join: Row | null;
      kind: Reading['kind'];
      severity: Reading['severity'];
      by: 'agent' | 'reporter';
    }
  | { ok: false; refusal: Refusal }
> {
  const candidates = await candidatesOf(projectId, request.said);
  const read = await readingOf(projectId, request.said, request.whereSeen, candidates);
  if (!read.ok) {
    if (!request.kind) {
      return {
        ok: false,
        refusal: {
          code: 'FEEDBACK_KIND_NEEDED',
          path: '/kind',
          detail: `${read.why}; send the report again with kind: ${FEEDBACK_REPORT_KINDS.join(', ')}.`,
        },
      };
    }
    return { ok: true, join: null, kind: request.kind, severity: 'medium', by: 'reporter' };
  }
  const same = read.reading.sameAs?.trim().toUpperCase();
  const join = same ? (candidates.find((c) => feedbackKey(c.fbSeq) === same) ?? null) : null;
  return {
    ok: true,
    join,
    kind: request.kind ?? read.reading.kind,
    severity: read.reading.severity,
    by: request.kind ? 'reporter' : 'agent',
  };
}

type Screenshot = (CheckedAttachment & { redacted: boolean; path: string }) | null;

/** Joins the open item `rootId`: the screenshot onto it where it has room, then the occurrence. */
async function joinIn(
  tx: Tx,
  o: {
    projectId: string;
    rootId: string;
    actor: FeedbackActor;
    said: string;
    level: SensitiveDataLevel;
  },
  shot: Screenshot,
): Promise<{ joined: boolean; screenshot: FeedbackReportResponse['screenshot'] }> {
  const root = await rowIn(tx, o.projectId, o.rootId, true);
  if (root.redactedAt) return { joined: false, screenshot: { state: 'none' } };
  let attachmentId: string | null = null;
  let screenshot: FeedbackReportResponse['screenshot'] = { state: 'none' };
  if (shot) {
    const put = await insertAttachmentIn(tx, root, shot, o.actor.userId, o.level);
    if (put.ok) {
      attachmentId = put.id;
      screenshot = { state: 'kept' };
    } else {
      screenshot = { state: 'not_kept', why: put.refusal.detail };
    }
  }
  await addOccurrenceIn(
    tx,
    root.id,
    o.actor,
    { projectId: o.projectId, issueId: null, runId: null, clientVersion: null },
    { said: storedText(o.level, o.said).text, attachmentId },
  );
  return { joined: true, screenshot };
}

export async function fileFeedbackReport(input: {
  projectId: string;
  actor: FeedbackActor;
  request: FeedbackReportRequest;
}): Promise<ReportOutcome> {
  const { projectId, actor, request } = input;
  // anyone who can read the page reports on it, as themselves (REQ-66 BC-1)
  await requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));
  const checked = request.screenshot ? checkedAttachment(request.screenshot, '/screenshot') : null;
  if (checked && !checked.ok) return { ok: false, refusals: [checked.refusal] };
  const place = await placeOf(projectId, request);
  if (!place.ok) return { ok: false, refusals: [place.refusal] };
  const level = await dataPolicyOf(projectId);
  const target = targetOfPage(request.whereSeen);
  let prepared = await preparedFeedback(projectId, actor, {
    kind: place.kind,
    severity: place.severity,
    title: request.said,
    // a screen target is where it was seen; a keyed one keeps the page beside it
    ...('screen' in target ? {} : { whereSeen: request.whereSeen }),
    ...(request.writtenLang ? { writtenLang: request.writtenLang } : {}),
    ...target,
  });
  // a page whose key no longer resolves is still the page it was seen on
  if (!prepared.ok && !('screen' in target)) {
    prepared = await preparedFeedback(projectId, actor, {
      kind: place.kind,
      severity: place.severity,
      title: request.said,
      screen: request.whereSeen,
      ...(request.writtenLang ? { writtenLang: request.writtenLang } : {}),
    });
  }
  if (!prepared.ok) return prepared;
  const newId: string = randomUUID();
  const itemId = place.join?.id ?? newId;
  const shot: Screenshot =
    checked?.ok && request.screenshot
      ? {
          ...checked.file,
          redacted: request.screenshot.redacted,
          path: await storedAttachment(projectId, itemId, checked.file),
        }
      : null;
  let id: string = newId;
  let created = false;
  let screenshot: FeedbackReportResponse['screenshot'] = { state: shot ? 'kept' : 'none' };
  const values = prepared.values;
  const refusals = await inTx(async (tx) => {
    await lockFeedback(tx, projectId);
    if (place.join) {
      const open = await openRootIn(tx, projectId, place.join);
      if (open) {
        const joined = await joinIn(
          tx,
          { projectId, rootId: open.id, actor, said: request.said, level },
          shot,
        );
        if (joined.joined) {
          id = open.id;
          screenshot = joined.screenshot;
          return null;
        }
      }
    }
    // a new item: its own, or one the item it repeated closed under it meanwhile
    id = await insertFeedbackIn(tx, { ...values, id: newId });
    created = true;
    if (shot) {
      const put = await insertAttachmentIn(
        tx,
        { ...values, id: newId, fbSeq: 0 },
        shot,
        actor.userId,
        level,
      );
      if (!put.ok) return [put.refusal];
    }
    return null;
  });
  if (refusals) {
    if (shot) await dropStored(shot.path);
    return { ok: false, refusals };
  }
  if (shot && screenshot.state !== 'kept') await dropStored(shot.path);
  if (created) embedFeedbackLater(id);
  const view = await answer(projectId, id, actor, { created });
  if (!view.ok) return view;
  return { ok: true, feedback: view.feedback, created, filledBy: place.by, screenshot };
}
