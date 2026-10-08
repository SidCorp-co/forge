// A visual block reaches a message only through here, written by this service and never by a model's
// text. The block names its run, or a computed block its execution; either is read back as the asker,
// its frame is copied in, and the registry checks the result. A block that brings its own frame must
// bring exactly its source's, or it is refused naming each figure the source never held; a title or
// label stating a number its source does not hold is refused the same way, by the check its reply is
// screened with. A computed block carries its execution beside it and says it was computed, wherever
// it is read. A block a turn draws waits on that turn's stage until its reply is judged, and is posted
// only with a reply that passes.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ExecutionFacts } from '@forge/contracts/report-executions';
import type { ReportFrame, ReportRunFacts } from '@forge/contracts/report-queries';
import {
  blockToText,
  checkBlock,
  UTC_READING,
  VISUAL_BLOCK_VERSION,
  type VisualBlock,
} from '@forge/contracts/visual-blocks';
import type { Refusal } from '../lib/refusal.js';
import { RefusalError } from '../lib/refusal.js';
import type { BlockStage, StagedBlock } from '../lib/staged-block.js';
import { blockTextsIn, figureFactsOf, ungroundedBlockFigures } from '../messaging/figures-rule.js';
import { readExecution } from './executions.js';
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
  /** The execution a computed block was drawn from; its frame is labelled computed. */
  execution: ExecutionFacts | null;
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

interface Sourced {
  block: Record<string, unknown>;
  facts: ReportRunFacts | null;
  execution: ExecutionFacts | null;
}

/** A frame the block brought must be its source's exactly; every figure that departs is named. */
function sameFrame(given: unknown, held: ReportFrame, sourceId: string, omitHint: string): void {
  if (given === undefined) return;
  const differences = figuresNotInRun(given, held, sourceId);
  if (differences.length > 0) {
    throw refusedBlock(
      'REPORT_BLOCK_FIGURE_NOT_IN_RUN',
      differences.map((d) => `${d}. A block's figures are its source's alone; ${omitHint}`),
    );
  }
}

/**
 * The execution a computed block names and the frame it draws, read back as the asker: the frame at
 * `source.frame`, which may be left out only where the execution answered one.
 */
async function executionSourced(
  raw: Record<string, unknown>,
  source: Record<string, unknown>,
  asker: { userId: string; agency: ActorAgency },
  projectId: string,
  now: Date,
): Promise<Sourced> {
  const { executionId, frame: index } = source;
  if (typeof executionId !== 'string' || executionId === '') {
    throw refuse(
      'REPORT_BLOCK_REFUSED',
      `the block's source is ${JSON.stringify(source)}; a computed block names its execution as { executionId, frame? }`,
      '/block/source',
    );
  }
  const execution = await readExecution({ executionId, ...asker, projectId, now });
  if (execution.frames.length === 0) {
    throw refuse(
      'REPORT_BLOCK_REFUSED',
      `execution ${executionId} answered no frame${execution.stopped ? ` (it was stopped by ${execution.stopped})` : ''}, so there is nothing to draw; say what it returned in the reply`,
      '/block/source/executionId',
    );
  }
  if (index === undefined && execution.frames.length > 1) {
    throw refuse(
      'REPORT_BLOCK_REFUSED',
      `execution ${executionId} answered ${execution.frames.length} frames; name the one drawn as source.frame, 0 to ${execution.frames.length - 1}`,
      '/block/source/frame',
    );
  }
  const at = typeof index === 'number' ? index : 0;
  const frame = execution.frames[at];
  if (!frame) {
    throw refuse(
      'REPORT_BLOCK_REFUSED',
      `execution ${executionId} answered ${execution.frames.length} frame(s); source.frame ${JSON.stringify(index)} is not one of 0 to ${execution.frames.length - 1}`,
      '/block/source/frame',
    );
  }
  sameFrame(
    raw.frame,
    frame,
    executionId,
    `omit frame and execution ${executionId}'s is copied in`,
  );
  return {
    block: { ...raw, frame },
    facts: null,
    execution: {
      executionId,
      adapter: execution.adapter,
      language: execution.language,
      at: execution.createdAt,
    },
  };
}

/** The source a block names and the frame it will hold, or none for a flow block that names none. */
async function sourced(
  raw: Record<string, unknown>,
  asker: { userId: string; agency: ActorAgency },
  projectId: string,
  now: Date,
): Promise<Sourced> {
  const source = raw.source;
  if (source === undefined) return { block: raw, facts: null, execution: null };
  if (isObject(source) && 'executionId' in source) {
    return executionSourced(raw, source, asker, projectId, now);
  }
  if (!isObject(source) || typeof source.runId !== 'string' || source.runId === '') {
    throw refuse(
      'REPORT_BLOCK_REFUSED',
      `the block's source is ${JSON.stringify(source)}; a block names the run its figures came from as { runId }, or a computed block its execution as { executionId, frame? }`,
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
  sameFrame(raw.frame, run.frame, run.runId, `omit frame and run ${run.runId}'s is copied in`);
  return { block: { ...raw, frame: run.frame }, facts: factsOf(run), execution: null };
}

/**
 * Refuses a block whose title or labels state a number its source does not hold, naming each one: the
 * check its reply is screened with (`messaging/figures-rule.ts:ungroundedBlockFigures`), held here to
 * the block's own run or execution, so the model corrects it inside the turn. A block that names no run holds
 * no figure at all, and a number the person typed grounds none (REQ-32 BC-5).
 */
function refuseTypedFigures(
  raw: Record<string, unknown>,
  frame: unknown,
  source: string | null,
): void {
  const frames = source === null ? [] : [frame as ReportFrame];
  const typed = ungroundedBlockFigures(
    blockTextsIn(JSON.stringify(raw)),
    figureFactsOf('', frames),
  );
  if (typed.length === 0) return;
  throw refusedBlock(
    'REPORT_BLOCK_FIGURE_NOT_IN_RUN',
    typed.map(({ text, figure }) =>
      source === null
        ? `the ${text.kind} block's ${text.key} "${text.text}" states the figure ${figure.quote}, and the block names no run to hold it: take the number out of the ${text.key}, or draw it from a forge_report run's frame`
        : `the ${text.kind} block's ${text.key} "${text.text}" states the figure ${figure.quote}, which ${source} does not hold: a block's text holds no figure of its own, so take it out of the ${text.key} and let the frame show it`,
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
  const { block, facts, execution } = await sourced(
    { v: VISUAL_BLOCK_VERSION, ...args.raw },
    args.asker,
    args.projectId,
    now,
  );
  const sourceName = facts
    ? `run ${facts.runId}`
    : execution
      ? `execution ${execution.executionId}`
      : null;
  refuseTypedFigures(args.raw, block.frame, sourceName);
  const checked = checkBlock(block);
  if (!checked.ok)
    throw refusedBlock(
      'REPORT_BLOCK_REFUSED',
      checked.refusals.map((r) => r.message),
    );
  const drawn = blockToText(checked.block, UTC_READING);
  // a computed block says so wherever it is read as text, not only where it is drawn
  const text = execution
    ? `${drawn}\n\nComputed by execution ${execution.executionId} (${execution.language} on ${execution.adapter}), not read from a report.`
    : drawn;
  const visual = {
    type: 'visual' as const,
    visual: checked.block,
    ...(facts ? { run: facts } : {}),
    ...(execution ? { execution } : {}),
  };
  const attached = { kind: checked.block.kind, run: facts, execution, text };
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
