// How a chat answer is shared: the `message` subject source of the Share port. Any message of an
// assistant turn shares the whole turn as one frozen document, named by the question it answered:
// the reply the room was shown, and every visual block the turn posted, in order, with the runs they
// were drawn from. A turn posts its blocks as their own messages above its reply, so freezing the
// one message a person pressed Share on froze one block and none of the answer (lane A8d, dev.185).
//
// Every run is read again, now, as the person creating the share. A run they can no longer read
// (another member's, one past its keep, one whose permission they no longer hold) refuses the share
// by name, so a share never carries more than its creator may see today. A tool call's input and
// output are never frozen: they are the asker's, and the document holds only what the room read.

import type { ReportRun } from '@forge/contracts/report-queries';
import {
  REPORT_DOCUMENT_REPLY_MAX,
  REPORT_DOCUMENT_TITLE_MAX,
  type ReportDocument,
} from '@forge/contracts/report-templates';
import { SHARE_SUBJECT_KINDS, type ShareRefusalCode } from '@forge/contracts/shares';
import { checkBlock, type VisualBlock } from '@forge/contracts/visual-blocks';
import { refuser } from '../lib/refusal.js';
import type { ShareSubjectSource } from '../shares/index.js';
import { figuresNotInRun } from './figures.js';
import { type ChatTurnMessage, reportsPorts } from './ports.js';
import { readReportRun } from './runs.js';

const refuseShare = refuser<ShareRefusalCode>('SHARE_REFUSED');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The template id a frozen chat answer carries: it was drawn by the assistant, not from a template. */
export const CHAT_ANSWER_DOCUMENT = 'chat-answer';
/** 2: the whole turn, with its question as `title` and its reply as `reply`. 1 froze one message's blocks. */
const CHAT_ANSWER_VERSION = 2;
/** How much of the question names the document before it is cut at a word. */
const TITLE_CHARS = 120;

const notFound = (messageId: string, why: string) =>
  refuseShare('SHARE_SUBJECT_NOT_FOUND', `message ${messageId} ${why}`, '/subjectId');

type StoredVisual = { type: 'visual'; visual?: unknown };

const visualsOf = (m: ChatTurnMessage): StoredVisual[] =>
  (Array.isArray(m.blocks) ? m.blocks : []).filter(
    (b): b is StoredVisual =>
      b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'visual',
  );

const deliveryKeyOf = (m: ChatTurnMessage): string | null => {
  const key = (m.deliveryProof as { deliveryKey?: unknown } | null)?.deliveryKey;
  return typeof key === 'string' ? key : null;
};

/**
 * What the turn said in words: each message that is neither a block's own nor a silence, oldest
 * first. A partial reply whose rest followed (`<key>` beside `<key>:continued`) gives way to the rest,
 * which carries the answer; the partial only said the turn was still working.
 */
export function replyOf(messages: readonly ChatTurnMessage[]): string | null {
  const said = messages.filter(
    (m) => m.silenceReason === null && m.content.trim() !== '' && visualsOf(m).length === 0,
  );
  const continued = new Set(said.map(deliveryKeyOf).filter((k): k is string => k !== null));
  const reply = said
    .filter((m) => {
      const key = deliveryKeyOf(m);
      return key === null || !continued.has(`${key}:continued`);
    })
    .map((m) => m.content.trim())
    .join('\n\n');
  return reply ? reply.slice(0, REPORT_DOCUMENT_REPLY_MAX) : null;
}

/** The question as a name: one line, cut at a word within {@link TITLE_CHARS}, an ellipsis where cut. */
export function titleOfQuestion(question: string | null): string | null {
  const line = (question ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  if (line.length <= TITLE_CHARS) return line;
  const cut = line.slice(0, TITLE_CHARS);
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(TITLE_CHARS / 2)));
  return `${atWord.trimEnd().replace(/[,;:.]+$/, '')}…`.slice(0, REPORT_DOCUMENT_TITLE_MAX);
}

export const messageShareSource: ShareSubjectSource = {
  kind: SHARE_SUBJECT_KINDS[0],
  async freeze({ projectId, subjectId, userId, agency }): Promise<ReportDocument> {
    const ports = reportsPorts();
    const turn = UUID.test(subjectId) ? await ports.turnOf(subjectId) : null;
    if (!turn) throw notFound(subjectId, 'is not a stored chat message');
    const room = await ports.roomOf(turn.conversationId, userId);
    if (!room.projectIds.includes(projectId)) {
      throw notFound(
        subjectId,
        `sits in a room about ${room.projectIds.join(', ') || 'no project'}, not project ${projectId}`,
      );
    }
    if (turn.role !== 'assistant') {
      throw notFound(
        subjectId,
        `is a ${turn.role === 'user' ? "person's" : turn.role} message; a share freezes an assistant's answer, from any message of it`,
      );
    }
    const runs = new Map<string, ReportRun>();
    const blocks: VisualBlock[] = [];
    for (const message of turn.messages) {
      for (const [i, stored] of visualsOf(message).entries()) {
        const checked = checkBlock(stored.visual);
        if (!checked.ok) {
          throw refuseShare(
            'SHARE_SNAPSHOT_INVALID',
            `message ${message.id} block ${i} no longer passes its kind's check: ${checked.refusals.map((r) => r.message).join('; ')}`,
          );
        }
        const block = checked.block;
        if (block.source && 'runId' in block.source) {
          const runId = block.source.runId;
          const run =
            runs.get(runId) ?? (await readReportRun({ runId, userId, agency, projectId }));
          const drift = figuresNotInRun(block.frame, run.frame, runId);
          if (drift.length > 0) {
            throw refuseShare(
              'SHARE_SNAPSHOT_INVALID',
              `message ${message.id} block ${i} holds figures its run did not read: ${drift.join('; ')}`,
            );
          }
          runs.set(runId, run);
        } else if (block.source) {
          throw refuseShare(
            'SHARE_SNAPSHOT_INVALID',
            `message ${message.id} block ${i} is sourced from an execution, which no share can re-read yet`,
          );
        }
        blocks.push(block);
      }
    }
    const reply = replyOf(turn.messages);
    if (blocks.length === 0 && reply === null) {
      throw notFound(
        subjectId,
        'belongs to a turn that said nothing and drew no report block, so there is no answer to share',
      );
    }
    const title = titleOfQuestion(turn.question);
    return {
      templateId: CHAT_ANSWER_DOCUMENT,
      version: CHAT_ANSWER_VERSION,
      params: {},
      runs: [...runs.values()],
      blocks,
      // a chat answer's words are its reply, not a template's slots: no slot is written, and the
      // share page shows only the slots that are
      narrative: { summary: '', risks: '', recommendations: '' },
      ...(title ? { title } : {}),
      ...(reply ? { reply } : {}),
    };
  },
};
