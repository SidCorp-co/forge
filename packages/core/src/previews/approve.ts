// A preview's approval and what reaches its run (REQ-39; docs/proposals/live-preview.md "Flow"):
// the box reads the change it serves, the preview closes approved with it and its lane, and the run
// is told; a person's message for a change goes to the same run as an inject.

import { randomUUID } from 'node:crypto';
import { classifyLane } from '@forge/contracts/fast-lane';
import { PREVIEW_MACHINE, type PreviewReport } from '@forge/contracts/preview';
import { eq } from 'drizzle-orm';
import { requestSessionSend } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { type PreviewRow, previews } from '../db/schema-previews.js';
import { logger } from '../lib/logger.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { readProjectDocument } from '../project-config/index.js';
import {
  accessFor,
  type PreviewActor,
  pushBox,
  refuse,
  rowOf,
  SOURCE,
  siteOrRefuse,
  startedAt,
  throwRefusal,
  userActor,
  view,
} from './access.js';
import { previewOrigin } from './domain.js';
import { OPEN_STATES, stateRefusal } from './rules.js';

const SNAPSHOT_WAIT_MS = 20_000;

/** Waiters for a snapshot the approval asked of the box, by preview. */
const snapshots = new Map<string, (s: Extract<PreviewReport, { kind: 'snapshot' }>) => void>();

/** Hand a snapshot the box reported to the approval waiting on it; false when none waits. */
export function settleSnapshot(
  previewId: string,
  report: Extract<PreviewReport, { kind: 'snapshot' }>,
): boolean {
  const settle = snapshots.get(previewId);
  if (!settle) return false;
  settle(report);
  return true;
}

async function askSnapshot(row: PreviewRow) {
  const answered = new Promise<Extract<PreviewReport, { kind: 'snapshot' }>>((resolve, reject) => {
    const timer = setTimeout(() => {
      snapshots.delete(row.id);
      reject(
        refuse(
          'PREVIEW_SNAPSHOT_UNAVAILABLE',
          `the box holding preview ${row.id} did not answer with what it serves within ${SNAPSHOT_WAIT_MS / 1000}s: it is offline, or the worktree holds no change against its base; nothing was approved`,
        ),
      );
    }, SNAPSHOT_WAIT_MS);
    snapshots.set(row.id, (s) => {
      clearTimeout(timer);
      snapshots.delete(row.id);
      resolve(s);
    });
  });
  await db.transaction((tx) =>
    pushBox(tx, row.deviceId, 'preview.snapshot.read', { previewId: row.id }),
  );
  return answered;
}

/**
 * Approve what the preview shows (BC-9, BC-7): the box reads the patch id and files of the change
 * it serves, the preview closes approved with them and the lane they classify to, and the run is
 * told its lane. Needs `previews.approve`.
 */
export async function approvePreview(previewId: string, actor: PreviewActor) {
  const row = await rowOf(previewId);
  await accessFor(row.projectId, actor, 'previews.approve', 'approve the preview');
  throwRefusal(stateRefusal(row.id, row.state, ['live', 'idle_closed'], 'be approved'));
  const snapshot = await askSnapshot(row);
  const fastLane = (await readProjectDocument(row.projectId))?.document.fastLane ?? null;
  const lane = classifyLane(snapshot.files, fastLane);
  const moved = await transition(db, PREVIEW_MACHINE, {
    to: 'approved',
    expect: row.state,
    where: eq(previews.id, row.id),
    set: {
      approvedPatchId: snapshot.patchId,
      approvedFiles: snapshot.files,
      laneDecision: lane,
      approvedBy: actor.userId,
      closedAt: new Date(),
    },
    actor: userActor(actor),
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await pushBox(tx, row.deviceId, 'preview.stop', { previewId: r.id, why: 'approved' });
      }
    },
  });
  const approved = movedRow(moved) as PreviewRow;
  startedAt.delete(row.id);
  const told = await tellRun(
    approved,
    laneMessage(approved, lane),
    `preview-approved:${row.id}`,
    actor,
  );
  return { preview: view(approved), lane, patchId: snapshot.patchId, runTold: told };
}

function laneMessage(row: PreviewRow, lane: ReturnType<typeof classifyLane>): string {
  const head = `The live preview of this issue was approved at patch id ${row.approvedPatchId}.`;
  if (lane.lane === 'fast') {
    return `${head} Its ${lane.files.length} file(s) classify to the fast lane: rebase on the base, run the fast-lane merge checks (typecheck and the touched files' direct tests), merge, and deploy the web targets only.`;
  }
  const causes = lane.causes
    .map((c) => (c.file ? `${c.file} (${c.area}${c.glob ? `, ${c.glob}` : ''})` : c.area))
    .join('; ');
  return `${head} It takes the full lane: ${causes}. Finish it through the full gates.`;
}

async function tellRun(
  row: PreviewRow,
  body: string,
  intentId: string,
  actor: PreviewActor,
): Promise<boolean> {
  try {
    const sent = await requestSessionSend({
      agentSessionId: row.sessionId,
      kind: 'inject',
      intentId,
      body,
      actor: { userId: actor.userId, reason: 'preview', source: 'rest' },
    });
    return sent.published;
  } catch (err) {
    logger.warn({ err, previewId: row.id }, 'previews: the run could not be told');
    return false;
  }
}

/**
 * A person asks for a change in the preview's run (BC-6): the message goes to the run holding the
 * worktree as an inject, and its edit reaches the same preview by the dev server's hot reload.
 * Needs `project.write`; writes no record of its own.
 */
export async function sendPreviewMessage(previewId: string, actor: PreviewActor, text: string) {
  const row = await rowOf(previewId);
  await accessFor(row.projectId, actor, 'project.write', 'send the run a change');
  throwRefusal(stateRefusal(row.id, row.state, OPEN_STATES, 'take a change'));
  const url = `${previewOrigin(siteOrRefuse(), row.slug)}/`;
  const sent = await requestSessionSend({
    agentSessionId: row.sessionId,
    kind: 'inject',
    intentId: randomUUID(),
    body: `A person viewing the live preview of this issue (${url}) asks for a change:\n\n${text}\n\nMake it in this worktree; the preview shows it by hot reload, with no build or deploy.`,
    actor: { userId: actor.userId, reason: 'preview message', source: 'rest' },
  });
  if (!sent.published) {
    throw refuse(
      'PREVIEW_NO_RUN',
      `the run holding preview ${row.id} has no box to reach: nothing was sent`,
    );
  }
  return { sent: true as const, seq: sent.row.seq };
}
