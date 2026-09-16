/**
 * What a dead run left, written onto the issues it was holding.
 *
 * Two blocks, and they are never merged. The first is what the BOX could see —
 * branch, head, base, files touched, why the run ended — reconstructed by
 * `daemon/checkpoint.rs` and carried here verbatim. The second is TESTIMONY:
 * the `next` the run wrote onto its own lease, read back from the tracker byte
 * for byte, and printed empty when the run died before it wrote one.
 *
 * An empty testimony block is the honest answer. Filling it from the box would
 * be this module inventing a statement nobody made, and a master reading it
 * could not tell which of the two it was looking at.
 *
 * Nothing here decides anything. There is no verdict, no recommendation and no
 * "resumable" flag: whether work continues or restarts is the master's call,
 * and a surface that hands down a pre-computed answer has moved that judgement
 * into the kernel through a second door (ISS-1050).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { agentSessions, comments, devices, issues, pipelineRuns } from '../db/schema.js';
import { canonicalIssueKey } from '../lib/issue-ref.js';
import { logger } from '../logger.js';
import {
  BOX_RUN_ID_METADATA_KEY,
  RUN_ISSUES_METADATA_KEY,
  RUN_SESSION_TYPE,
} from './run-session.js';

/**
 * The box's half, exactly as `daemon/checkpoint.rs` puts it on the wire.
 */
export const runCheckpointSchema = z
  .object({
    source: z.string().min(1).max(64),
    branch: z.string().max(400).nullish(),
    head: z.string().max(64).nullish(),
    base: z.string().max(64).nullish(),
    filesTouched: z.array(z.string().max(400)).max(500).optional(),
    commitsAhead: z.number().int().nonnegative().nullish(),
    commitsUnpushed: z.number().int().nonnegative().nullish(),
    workingTreeDirty: z.boolean().nullish(),
    endedBy: z.string().max(64).nullish(),
    endedReason: z.string().max(500).nullish(),
    unread: z.array(z.string().max(500)).max(50).optional(),
  })
  .strict();

export type RunCheckpoint = z.infer<typeof runCheckpointSchema>;

export const RECONSTRUCTION_SOURCE = 'reconstructed_from_box';

/** The line that makes a second write of the same evidence a no-op. */
export function runEvidenceMarker(sessionId: string): string {
  return `run-evidence: ${sessionId}`;
}

/**
 * A fence that the content cannot break out of.
 */
function fenceFor(content: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function reconstructionBlock(cp: RunCheckpoint): string {
  const lines: string[] = ['### Reconstructed from the box', ''];
  const row = (label: string, value: string | number | boolean | null | undefined): void => {
    lines.push(
      `- ${label}: ${value === null || value === undefined ? '_not read_' : `\`${value}\``}`,
    );
  };
  row('branch', cp.branch);
  row('head', cp.head);
  row('base', cp.base);
  row('commits ahead of base', cp.commitsAhead);
  row('commits no remote has', cp.commitsUnpushed);
  row('working tree dirty', cp.workingTreeDirty);
  row('ended by', cp.endedBy);
  row('ended reason', cp.endedReason);
  const files = cp.filesTouched ?? [];
  lines.push('', `Files touched (${files.length}):`);
  lines.push(files.length === 0 ? '- _none_' : files.map((f) => `- \`${f}\``).join('\n'));
  const unread = cp.unread ?? [];
  if (unread.length > 0) {
    lines.push('', 'Could not be read:');
    lines.push(unread.map((u) => `- ${u}`).join('\n'));
  }
  return lines.join('\n');
}

function testimonyBlock(next: string | null): string {
  const head = '### What the run said about itself';
  if (next === null || next === '') {
    return `${head}\n\n_The run wrote nothing onto its lease before it ended._`;
  }
  const fence = fenceFor(next);
  return `${head}\n\n${fence}text\n${next}\n${fence}`;
}

export function buildRunEvidenceBody(args: {
  sessionId: string;
  checkpoint: RunCheckpoint;
  next: string | null;
}): string {
  return [
    '## A run holding this issue ended',
    '',
    `\`${runEvidenceMarker(args.sessionId)}\``,
    '',
    'Two separate records, neither derived from the other. Nothing here decides whether the work',
    'continues or restarts.',
    '',
    reconstructionBlock(args.checkpoint),
    '',
    testimonyBlock(args.next),
  ].join('\n');
}

/**
 * A worktree this box is still holding because its work is on no remote.
 */
export const heldWorktreeSchema = z
  .object({
    worktree: z.string().min(1).max(1024),
    branch: z.string().max(400).nullish(),
    head: z.string().min(1).max(64),
    commitsUnpushed: z.number().int().nonnegative().nullish(),
    reason: z.string().min(1).max(600),
  })
  .strict();

export type HeldWorktree = z.infer<typeof heldWorktreeSchema>;

/**
 * What a resumed master decided about a run it inherited.
 */
export const resumeChoiceSchema = z
  .object({
    runId: z.string().min(1).max(200),
    choice: z.enum(['continue', 'restart', 'leave']),
    why: z.string().min(1).max(2000),
  })
  .strict();

export type ResumeChoice = z.infer<typeof resumeChoiceSchema>;

/** The line that makes a second report of the SAME choice a no-op. */
export function resumeChoiceMarker(runId: string): string {
  return `resume-choice: ${runId}`;
}

export function buildResumeChoiceBody(args: { choice: ResumeChoice }): string {
  const { choice } = args;
  const said = {
    continue: 'carry this work on from where it stopped',
    restart: 'start this work again rather than carry it on',
    leave: "leave this work alone — it is somebody else's to settle",
  }[choice.choice];
  return [
    `## The master that picked this issue back up chose to **${choice.choice}**`,
    '',
    `\`${resumeChoiceMarker(choice.runId)}\``,
    '',
    'The machine handing out work on this project was interrupted and has been resumed. It found',
    'this issue still held by a run from before the interruption, and had to decide what happens to',
    'that work before it could hand out anything new.',
    '',
    `It chose to ${said}.`,
    '',
    'In its own words:',
    '',
    `> ${choice.why.replace(/\n/g, '\n> ')}`,
    '',
    "That judgement is the resumed machine's own. It was handed the run's branch, checkout and",
    'state as plain facts with no recommendation attached, and this is what it made of them.',
  ].join('\n');
}

/** The line that makes a second report of the SAME held state a no-op. */
export function heldWorktreeMarker(sessionId: string, head: string): string {
  return `held-worktree: ${sessionId}:${head}`;
}

export function buildHeldWorktreeBody(args: { sessionId: string; held: HeldWorktree }): string {
  const { held } = args;
  const count = held.commitsUnpushed ?? null;
  return [
    '## Work on this issue is on one machine only',
    '',
    `\`${heldWorktreeMarker(args.sessionId, held.head)}\``,
    '',
    `A run that was working this issue has stopped, and its checkout has **not** been released,`,
    'because the box could not establish that its commits are on a remote.',
    '',
    `- branch: ${held.branch ? `\`${held.branch}\`` : '_not read_'}`,
    `- commit: \`${held.head}\``,
    count === null ? '- commits on no remote: _not counted_' : `- commits on no remote: ${count}`,
    `- checkout: \`${held.worktree}\``,
    '',
    `Why it is held: ${held.reason}`,
    '',
    'Nothing about this issue has been moved. The box retries on every sweep, so a remote that',
    'becomes reachable releases the checkout with no action from anybody. This is here so that a',
    "remote which does *not* become reachable is somebody's to see rather than nobody's.",
  ].join('\n');
}

interface RunIssueRow {
  id: string;
  next: string | null;
}

/** One device's run session, whatever status it has reached. */
async function runSessionForDevice(
  deviceId: string,
  sessionId: string,
): Promise<{ projectId: string; issueKeys: string[] | null; boxRunId: string | null } | undefined> {
  const [row] = await db
    .select({
      projectId: agentSessions.projectId,
      issueKeys: sql<string[] | null>`${pipelineRuns.metadata} -> ${RUN_ISSUES_METADATA_KEY}`,
      boxRunId: sql<string | null>`${pipelineRuns.metadata} ->> ${BOX_RUN_ID_METADATA_KEY}`,
    })
    .from(agentSessions)
    .innerJoin(pipelineRuns, eq(pipelineRuns.id, agentSessions.pipelineRunId))
    .where(
      and(
        eq(agentSessions.id, sessionId),
        eq(agentSessions.deviceId, deviceId),
        sql`${agentSessions.metadata}->>'type' = ${RUN_SESSION_TYPE}`,
      ),
    )
    .limit(1);
  return row;
}

/** The run's issues, and what each one's lease says the run said. */
async function runIssuesWithTestimony(
  projectId: string,
  issueKeys: string[],
): Promise<RunIssueRow[]> {
  const seqs = issueKeys
    .map((k) => Number.parseInt(k.replace(/^[A-Za-z]+-/, ''), 10))
    .filter((n) => Number.isFinite(n));
  if (seqs.length === 0) return [];
  return db
    .select({
      id: issues.id,
      next: sql<string | null>`${issues.sessionContext} #>> '{lease,next}'`,
    })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.issSeq, seqs)));
}

/**
 * Post one comment onto an issue, once, however many callers race to post it.
 */
async function insertCommentOnce(args: {
  issueId: string;
  marker: string;
  body: string;
  authorId: string;
  deviceId: string;
}): Promise<boolean> {
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`run-evidence:${args.issueId}:${args.marker}`}, 0))`,
    );
    const existing = await tx
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(eq(comments.issueId, args.issueId), sql`${comments.body} LIKE ${`%${args.marker}%`}`),
      )
      .limit(1);
    if (existing.length > 0) return false;
    await tx.insert(comments).values({
      issueId: args.issueId,
      authorId: args.authorId,
      authorDeviceId: args.deviceId,
      authorAgency: 'agent',
      body: args.body,
    });
    return true;
  });
}

export interface RunEvidenceResult {
  /** Issues the run was holding. */
  issues: number;
  /** Issues this call posted the evidence onto. */
  written: number;
}

/**
 * Write the two blocks onto every issue the run was holding.
 */
export async function writeRunEvidence(args: {
  deviceId: string;
  sessionId: string;
  checkpoint: RunCheckpoint;
}): Promise<RunEvidenceResult | null> {
  if (args.checkpoint.source !== RECONSTRUCTION_SOURCE) {
    throw new Error(
      `writeRunEvidence: a checkpoint must declare itself as \`${RECONSTRUCTION_SOURCE}\`, got \`${args.checkpoint.source}\` — an undeclared payload cannot be printed as the box's half without this end guessing what it is`,
    );
  }
  const session = await runSessionForDevice(args.deviceId, args.sessionId);
  if (!session) return null;

  const keys = (session.issueKeys ?? []).map((k) => canonicalIssueKey(Number(k.split('-')[1])));
  const rows = await runIssuesWithTestimony(session.projectId, keys);
  const marker = runEvidenceMarker(args.sessionId);
  let written = 0;

  const authorId = await ownerOfDevice(args.deviceId);
  for (const row of rows) {
    const body = buildRunEvidenceBody({
      sessionId: args.sessionId,
      checkpoint: args.checkpoint,
      next: row.next,
    });
    if (
      await insertCommentOnce({ issueId: row.id, marker, body, authorId, deviceId: args.deviceId })
    )
      written += 1;
  }

  logger.info(
    {
      sessionId: args.sessionId,
      deviceId: args.deviceId,
      boxRunId: session.boxRunId,
      issues: rows.length,
      written,
    },
    'run-evidence: what the run left is on its issues',
  );
  return { issues: rows.length, written };
}

/**
 * Say on every issue this run holds that its work is on one machine only.
 */
export async function writeHeldWorktreeReport(args: {
  deviceId: string;
  sessionId: string;
  held: HeldWorktree;
}): Promise<RunEvidenceResult | null> {
  const session = await runSessionForDevice(args.deviceId, args.sessionId);
  if (!session) return null;
  const keys = (session.issueKeys ?? []).map((k) => canonicalIssueKey(Number(k.split('-')[1])));
  const rows = await runIssuesWithTestimony(session.projectId, keys);
  const marker = heldWorktreeMarker(args.sessionId, args.held.head);
  const body = buildHeldWorktreeBody({ sessionId: args.sessionId, held: args.held });
  const authorId = await ownerOfDevice(args.deviceId);
  let written = 0;
  for (const row of rows) {
    if (
      await insertCommentOnce({ issueId: row.id, marker, body, authorId, deviceId: args.deviceId })
    )
      written += 1;
  }
  logger.warn(
    {
      sessionId: args.sessionId,
      deviceId: args.deviceId,
      branch: args.held.branch,
      head: args.held.head,
      commitsUnpushed: args.held.commitsUnpushed,
      issues: rows.length,
      written,
    },
    'run-evidence: a checkout is held because its work is on no remote',
  );
  return { issues: rows.length, written };
}

/**
 * Say on each issue a resumed master's inherited run holds what it chose and why.
 */
export async function writeResumeChoice(args: {
  deviceId: string;
  sessionId: string;
  choice: ResumeChoice;
}): Promise<RunEvidenceResult | null> {
  const session = await runSessionForDevice(args.deviceId, args.sessionId);
  if (!session) return null;
  const keys = (session.issueKeys ?? []).map((k) => canonicalIssueKey(Number(k.split('-')[1])));
  const rows = await runIssuesWithTestimony(session.projectId, keys);
  const marker = resumeChoiceMarker(args.choice.runId);
  const body = buildResumeChoiceBody({ choice: args.choice });
  const authorId = await ownerOfDevice(args.deviceId);
  let written = 0;
  for (const row of rows) {
    if (
      await insertCommentOnce({ issueId: row.id, marker, body, authorId, deviceId: args.deviceId })
    )
      written += 1;
  }
  logger.info(
    {
      sessionId: args.sessionId,
      deviceId: args.deviceId,
      runId: args.choice.runId,
      choice: args.choice.choice,
      issues: rows.length,
      written,
    },
    'run-evidence: a resumed master said what happens to a run it inherited',
  );
  return { issues: rows.length, written };
}

/** The person a box's credential belongs to, which is who a box's comment is authored as. */
async function ownerOfDevice(deviceId: string): Promise<string> {
  const [row] = await db
    .select({ ownerId: devices.ownerId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!row) throw new Error(`writeRunEvidence: no device ${deviceId}`);
  return row.ownerId;
}
