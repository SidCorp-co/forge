// A visual block reaches a message only through here, written by this service and never by a model's
// text. The block names its run; the run is read back as the asker, its frame is copied in, and the
// registry checks the result. A block that brings its own frame must bring exactly its run's, or it
// is refused naming each figure the run never read; a title or label stating a number its run does
// not hold is refused the same way, by the check its reply is screened with. A block a turn draws
// waits on that turn's stage until its reply is judged, and is posted only with a reply that passes.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ReportFrame, ReportRunFacts } from '@forge/contracts/report-queries';
import {
  blockToText,
  checkBlock,
  VISUAL_BLOCK_VERSION,
  type VisualBlock,
} from '@forge/contracts/visual-blocks';
import type { Refusal } from '../lib/refusal.js';
import { RefusalError } from '../lib/refusal.js';
import type { BlockStage, StagedBlock } from '../lib/staged-block.js';
import { blockTextsIn, figureFactsOf, ungroundedBlockFigures } from '../messaging/figures-rule.js';
import { figuresNotInRun } from './figures.js';
import { reportsPorts } from './ports.js';
import { factsOf, readReportRun, refuse } from './runs.js';

export interface AttachedBlock {
  /** The row the block was posted as; null while it waits on its turn's reply. */
  messageId: string | null;
  /** It waits on the reply of the turn that drew it, and is shown only with a reply that passes. */
  held: boolean;
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
 * Refuses a block whose title or labels state a number its run does not hold, naming each one: the
 * check its reply is screened with (`messaging/figures-rule.ts:ungroundedBlockFigures`), held here to
 * the block's own run, so the model corrects it inside the turn. A block that names no run holds
 * no figure at all; a number the person typed in the question may stand.
 */
function refuseTypedFigures(
  raw: Record<string, unknown>,
  frame: unknown,
  runId: string | null,
  asked: string,
): void {
  const frames = runId === null ? [] : [frame as ReportFrame];
  const typed = ungroundedBlockFigures(
    blockTextsIn(JSON.stringify(raw)),
    figureFactsOf(asked, frames),
  );
  if (typed.length === 0) return;
  throw refusedBlock(
    'REPORT_BLOCK_FIGURE_NOT_IN_RUN',
    typed.map(({ text, figure }) =>
      runId === null
        ? `the ${text.kind} block's ${text.key} "${text.text}" states the figure ${figure.quote}, and the block names no run to hold it: take the number out of the ${text.key}, or draw it from a forge_report run's frame`
        : `the ${text.kind} block's ${text.key} "${text.text}" states the figure ${figure.quote}, which run ${runId} does not hold: a block's text holds no figure of its own, so take it out of the ${text.key} and let the frame show it`,
    ),
  );
}

/**
 * Checks a proposed block against the registry and its run, and posts it into the room as the
 * project's answer — or, given a `stage`, holds it there until the reply of the turn that drew it is
 * judged. `raw` is a block of any registered kind with `source: { runId }` and no frame (the run's
 * is copied in); a `flow` block may name no run and then holds no figures.
 */
export async function attachVisualBlock(args: {
  conversationId: string;
  projectId: string;
  raw: unknown;
  asker: { userId: string; agency: ActorAgency };
  /** The turn the block waits on; null posts it now, for a caller that answers no turn. */
  stage: BlockStage | null;
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
  refuseTypedFigures(args.raw, block.frame, facts?.runId ?? null, args.stage?.question ?? '');
  const checked = checkBlock(block);
  if (!checked.ok)
    throw refusedBlock(
      'REPORT_BLOCK_REFUSED',
      checked.refusals.map((r) => r.message),
    );
  const text = blockToText(checked.block);
  const visual = {
    type: 'visual' as const,
    visual: checked.block,
    ...(facts ? { run: facts } : {}),
  };
  const attached = { kind: checked.block.kind, run: facts, text };
  if (args.stage) {
    const staged: StagedBlock = {
      text,
      block: visual,
      kind: checked.block.kind,
      runId: facts?.runId ?? null,
      projectId: args.projectId,
      askerUserId: args.asker.userId,
    };
    await args.stage.hold(staged);
    return { messageId: null, held: true, ...attached };
  }
  const { messageId } = await ports.postAnswer({
    conversationId: args.conversationId,
    projectId: args.projectId,
    askerUserId: args.asker.userId,
    content: text,
    blocks: [visual],
  });
  return { messageId, held: false, ...attached };
}
