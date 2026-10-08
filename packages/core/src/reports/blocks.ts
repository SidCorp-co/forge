// A visual block reaches a message only through here, written by this service and never by a model's
// text. The block names its run; the run is read back as the asker, its frame is copied in, and the
// registry checks the result. A block that brings its own frame must bring exactly its run's, or it
// is refused naming each figure the run never read.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReportRunFacts } from '@forge/contracts/report-queries';
import {
  blockToText,
  checkBlock,
  VISUAL_BLOCK_VERSION,
  type VisualBlock,
} from '@forge/contracts/visual-blocks';
import type { Refusal } from '../lib/refusal.js';
import { RefusalError } from '../lib/refusal.js';
import { figuresNotInRun } from './figures.js';
import { reportsPorts } from './ports.js';
import { factsOf, readReportRun, refuse } from './runs.js';

export interface AttachedBlock {
  messageId: string;
  kind: VisualBlock['kind'];
  run: ReportRunFacts | null;
  /** The block's plain-text fallback, as external doors and screen readers read it. */
  text: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function refusedBlock(
  code: 'REPORT_BLOCK_REFUSED' | 'REPORT_BLOCK_FIGURE_NOT_IN_RUN',
  messages: string[],
): RefusalError {
  const refusals: Refusal[] = messages.map((detail) => ({ code, path: '/block', detail }));
  return new RefusalError(refusals, code);
}

/** The run a block names and the frame it will hold, or null for a flow block that names none. */
async function sourced(
  raw: Record<string, unknown>,
  asker: { userId: string; agency: ActorAgency },
  projectId: string,
  now: Date,
): Promise<{ block: Record<string, unknown>; facts: ReportRunFacts | null }> {
  const source = raw.source;
  if (source === undefined) return { block: raw, facts: null };
  if (isObject(source) && 'executionId' in source) {
    throw refuse(
      'REPORT_BLOCK_SOURCE_UNSUPPORTED',
      'a block sourced from an execution needs the executor port, which no adapter fills yet; show a block of a report run: { source: { runId } }',
      '/block/source',
    );
  }
  if (!isObject(source) || typeof source.runId !== 'string' || source.runId === '') {
    throw refuse(
      'REPORT_BLOCK_REFUSED',
      `the block's source is ${JSON.stringify(source)}; a block names the run its figures came from as { runId }`,
      '/block/source',
    );
  }
  const run = await readReportRun({ runId: source.runId, ...asker, now });
  if (run.projectId !== projectId) {
    throw refuse(
      'REPORT_RUN_OTHER_PROJECT',
      `report run ${run.runId} read project ${run.projectId}, and this answer is about project ${projectId}; run the query in this project`,
      '/block/source/runId',
    );
  }
  if (raw.frame !== undefined) {
    const differences = figuresNotInRun(raw.frame, run.frame, run.runId);
    if (differences.length > 0) {
      throw refusedBlock(
        'REPORT_BLOCK_FIGURE_NOT_IN_RUN',
        differences.map(
          (d) =>
            `${d}. A block's figures are its run's alone; omit frame and run ${run.runId}'s is copied in`,
        ),
      );
    }
  }
  return { block: { ...raw, frame: run.frame }, facts: factsOf(run) };
}

/**
 * Checks a proposed block against the registry and its run, and posts it into the room as the
 * project's answer. `raw` is a block of any registered kind with `source: { runId }` and no frame
 * (the run's is copied in); a `flow` block may name no run and then holds no figures.
 */
export async function attachVisualBlock(args: {
  conversationId: string;
  projectId: string;
  raw: unknown;
  asker: { userId: string; agency: ActorAgency };
  now?: Date;
}): Promise<AttachedBlock> {
  const now = args.now ?? new Date();
  const ports = reportsPorts();
  const room = await ports.roomOf(args.conversationId, args.asker.userId);
  if (room.adapter !== 'web') {
    throw refuse(
      'REPORT_BLOCK_ROOM_NOT_WEB',
      `conversation ${args.conversationId} is a ${room.adapter} room, whose door posts text and draws no block; state the figures of the run in the reply instead`,
      '/conversationId',
    );
  }
  if (!room.projectIds.includes(args.projectId)) {
    throw refuse(
      'REPORT_RUN_OTHER_PROJECT',
      `conversation ${args.conversationId} is about ${room.projectIds.join(', ') || 'no project'}, not project ${args.projectId}`,
      '/projectId',
    );
  }
  if (!isObject(args.raw)) {
    throw refuse(
      'REPORT_BLOCK_REFUSED',
      `the block is ${JSON.stringify(args.raw)}, not an object`,
      '/block',
    );
  }
  const { block, facts } = await sourced(
    { v: VISUAL_BLOCK_VERSION, ...args.raw },
    args.asker,
    args.projectId,
    now,
  );
  const checked = checkBlock(block);
  if (!checked.ok)
    throw refusedBlock(
      'REPORT_BLOCK_REFUSED',
      checked.refusals.map((r) => r.message),
    );
  const text = blockToText(checked.block);
  const { messageId } = await ports.postAnswer({
    conversationId: args.conversationId,
    projectId: args.projectId,
    askerUserId: args.asker.userId,
    content: text,
    blocks: [{ type: 'visual', visual: checked.block, ...(facts ? { run: facts } : {}) }],
  });
  return { messageId, kind: checked.block.kind, run: facts, text };
}
