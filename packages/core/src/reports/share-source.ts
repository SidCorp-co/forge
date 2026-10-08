// How a chat answer is shared: the `message` subject source of the Share port. A message that holds
// visual blocks is frozen into one report document — its blocks and the runs they were drawn from —
// with every run read again, now, as the person creating the share. A run they can no longer read
// (another member's, one past its keep, one whose permission they no longer hold) refuses the share
// by name, so a share never carries more than its creator may see today.

import type { ReportRun } from '@forge/contracts/report-queries';
import type { ReportDocument } from '@forge/contracts/report-templates';
import { SHARE_SUBJECT_KINDS, type ShareRefusalCode } from '@forge/contracts/shares';
import { checkBlock, type VisualBlock } from '@forge/contracts/visual-blocks';
import { refuser } from '../lib/refusal.js';
import type { ShareSubjectSource } from '../shares/index.js';
import { figuresNotInRun } from './figures.js';
import { reportsPorts } from './ports.js';
import { readReportRun } from './runs.js';

const refuseShare = refuser<ShareRefusalCode>('SHARE_REFUSED');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The template id a frozen chat answer carries: it was drawn by the assistant, not from a template. */
export const CHAT_ANSWER_DOCUMENT = 'chat-answer';

const notFound = (messageId: string, why: string) =>
  refuseShare('SHARE_SUBJECT_NOT_FOUND', `message ${messageId} ${why}`, '/subjectId');

export const messageShareSource: ShareSubjectSource = {
  kind: SHARE_SUBJECT_KINDS[0],
  async freeze({ projectId, subjectId, userId, agency }): Promise<ReportDocument> {
    const ports = reportsPorts();
    const message = UUID.test(subjectId) ? await ports.messageOf(subjectId) : null;
    if (!message) throw notFound(subjectId, 'is not a stored chat message');
    const room = await ports.roomOf(message.conversationId, userId);
    if (!room.projectIds.includes(projectId)) {
      throw notFound(
        subjectId,
        `sits in a room about ${room.projectIds.join(', ') || 'no project'}, not project ${projectId}`,
      );
    }
    const visual = (Array.isArray(message.blocks) ? message.blocks : []).filter(
      (b): b is { type: 'visual'; visual?: unknown } =>
        b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'visual',
    );
    if (visual.length === 0) {
      throw notFound(
        subjectId,
        'holds no report block; a chat answer is shared by the blocks forge_show drew in it',
      );
    }
    const runs = new Map<string, ReportRun>();
    const blocks: VisualBlock[] = [];
    for (const [i, stored] of visual.entries()) {
      const checked = checkBlock(stored.visual);
      if (!checked.ok) {
        throw refuseShare(
          'SHARE_SNAPSHOT_INVALID',
          `message ${subjectId} block ${i} no longer passes its kind's check: ${checked.refusals.map((r) => r.message).join('; ')}`,
        );
      }
      const block = checked.block;
      if (block.source && 'runId' in block.source) {
        const runId = block.source.runId;
        const run = runs.get(runId) ?? (await readReportRun({ runId, userId, agency, projectId }));
        const drift = figuresNotInRun(block.frame, run.frame, runId);
        if (drift.length > 0) {
          throw refuseShare(
            'SHARE_SNAPSHOT_INVALID',
            `message ${subjectId} block ${i} holds figures its run did not read: ${drift.join('; ')}`,
          );
        }
        runs.set(runId, run);
      } else if (block.source) {
        throw refuseShare(
          'SHARE_SNAPSHOT_INVALID',
          `message ${subjectId} block ${i} is sourced from an execution, which no share can re-read yet`,
        );
      }
      blocks.push(block);
    }
    return {
      templateId: CHAT_ANSWER_DOCUMENT,
      version: 1,
      params: {},
      runs: [...runs.values()],
      blocks,
      // a chat answer's words are its reply, not a template's slots: no slot is written, and the
      // share page shows only the slots that are
      narrative: { summary: '', risks: '', recommendations: '' },
    };
  },
};
