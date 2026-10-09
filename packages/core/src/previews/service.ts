// A preview's writes (REQ-39; docs/proposals/live-preview.md "Flow"): open and reopen, the box's
// reports, abandon, the viewer ticket and the sweep; approval and a person's message to the run are
// in ./approve.ts. Every state is written by the kernel transition, and every frame the box is sent
// rides the outbox in the same transaction as the move that owes it.

import { randomBytes } from 'node:crypto';
import {
  detectPreviewSettings,
  PREVIEW_ENTER_PATH,
  PREVIEW_LIMITS,
  PREVIEW_MACHINE,
  type PreviewFailureReason,
  type PreviewRecord,
  type PreviewReport,
  type PreviewState,
} from '@forge/contracts/preview';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type PreviewRow, previews } from '../db/schema-previews.js';
import { loadProjectAccess } from '../lib/authz.js';
import { deviceRoom, roomManager } from '../lib/rooms.js';
import { type KernelActor, movedRow, transition } from '../lifecycle/index.js';
import { requireHeld } from '../permissions/index.js';
import {
  accessFor,
  type PreviewActor,
  planOf,
  pushBox,
  pushStart,
  refuse,
  rowOf,
  SOURCE,
  siteOrRefuse,
  startedAt,
  throwRefusal,
  userActor,
  view,
} from './access.js';
import { settleSnapshot } from './approve.js';
import { newPreviewLabel, previewOrigin } from './domain.js';
import {
  issueProjectOf,
  latestPreviewOfIssue,
  liveRunOfIssue,
  openPreviewOfSession,
  previewById,
  previewsIn,
  previewsWhoseRunEnded,
  previewView,
} from './read.js';
import { OPEN_STATES, type PreviewPlan, stateRefusal, sweepMove } from './rules.js';
import { signTicket } from './ticket.js';
import { tunnelStatus } from './tunnel.js';

export type { PreviewActor } from './access.js';
export { approvePreview, sendPreviewMessage } from './approve.js';

const VIEW_NOTE_MS = 30_000;

/** The issue's latest preview, as a project reader sees it, or null when it has none. */
export async function readIssuePreview(issueId: string, actor: PreviewActor) {
  const projectId = await issueProjectOf(issueId);
  if (projectId === null) throw refuse('PREVIEW_NOT_FOUND', `no issue ${issueId}`);
  await accessFor(projectId, actor, 'project.read', 'read its preview');
  const row = await latestPreviewOfIssue(issueId);
  return row && view(row);
}

export async function readPreview(previewId: string, actor: PreviewActor): Promise<PreviewRecord> {
  const row = await rowOf(previewId);
  await accessFor(row.projectId, actor, 'project.read', 'read the preview');
  return view(row);
}

/**
 * Open the preview of the issue's live run (BC-1): a run that holds a worktree on its box, which
 * holds one preview at a time. An idle-closed one is reopened at the same link.
 */
export async function openIssuePreview(
  issueId: string,
  actor: PreviewActor,
): Promise<{ preview: PreviewRecord; reopened: boolean }> {
  const site = siteOrRefuse();
  const projectId = await issueProjectOf(issueId);
  if (projectId === null) throw refuse('PREVIEW_NOT_FOUND', `no issue ${issueId}`);
  await accessFor(projectId, actor, 'project.write', 'open a preview');
  const run = await liveRunOfIssue(issueId);
  if (!run) {
    throw refuse(
      'PREVIEW_NO_RUN',
      `issue ${issueId} has no live run holding a worktree on a box: a preview serves the worktree a run is changing, so dispatch the issue first`,
    );
  }
  const open = await openPreviewOfSession(run.sessionId);
  if (open?.state === 'idle_closed') {
    return { preview: previewView(await reopen(open, userActor(actor)), site), reopened: true };
  }
  if (open) {
    throw refuse(
      'PREVIEW_ALREADY_OPEN',
      `this run already holds preview ${open.id}, ${open.state}, at ${previewOrigin(site, open.slug)}/: a run holds one preview at a time`,
    );
  }
  const plan = await planOf(projectId);
  const row = await insertPreview({ projectId, issueId, run, plan, createdBy: actor.userId });
  return { preview: previewView(row, site), reopened: false };
}

async function insertPreview(args: {
  projectId: string;
  issueId: string;
  run: { sessionId: string; deviceId: string };
  plan: PreviewPlan;
  createdBy: string;
}): Promise<PreviewRow> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(previews)
        .values({
          projectId: args.projectId,
          issueId: args.issueId,
          sessionId: args.run.sessionId,
          deviceId: args.run.deviceId,
          slug: newPreviewLabel((n) => randomBytes(n)),
          command: args.plan.settings?.command ?? '',
          port: args.plan.settings?.port ?? null,
          idleMinutes: args.plan.settings?.idleMinutes ?? PREVIEW_LIMITS.idleMinutes.default,
          createdBy: args.createdBy,
        })
        .returning();
      if (!row) throw new Error('previews: the insert returned no row');
      await pushStart(tx, row, args.plan);
      return row;
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw refuse(
        'PREVIEW_ALREADY_OPEN',
        `the run of issue ${args.issueId} opened a preview at the same moment: a run holds one preview at a time; read the issue's preview`,
      );
    }
    throw err;
  }
}

/** An idle-closed preview starts again in the same worktree at the same link. */
async function reopen(row: PreviewRow, actor: KernelActor): Promise<PreviewRow> {
  const plan = await planOf(row.projectId);
  const moved = await transition(db, PREVIEW_MACHINE, {
    to: 'starting',
    expect: 'idle_closed',
    where: eq(previews.id, row.id),
    set: {
      command: plan.settings?.command ?? row.command,
      port: plan.settings?.port ?? null,
      liveAt: null,
    },
    actor,
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) await pushStart(tx, { ...row, ...r }, plan);
    },
  });
  return movedRow(moved) as PreviewRow;
}

/** A viewer opened an idle-closed link: one who may write reopens it, any other reads it closed. */
export async function reopenForViewer(row: PreviewRow, userId: string): Promise<boolean> {
  const access = await loadProjectAccess(row.projectId, userId, 'preview not found');
  try {
    requireHeld(access, 'project.write', 'reopen the preview');
  } catch {
    return false;
  }
  await reopen(row, { type: 'user', id: userId, agency: 'human' });
  return true;
}

/** The viewer's request is recorded, at most every half minute, so the idle sweep sees it. */
export async function noteViewed(row: PreviewRow, now = Date.now()): Promise<void> {
  if (row.lastViewedAt && now - row.lastViewedAt.getTime() < VIEW_NOTE_MS) return;
  await db
    .update(previews)
    .set({ lastViewedAt: new Date(now) })
    .where(eq(previews.id, row.id));
}

async function fail(
  row: PreviewRow,
  from: readonly PreviewState[],
  reason: PreviewFailureReason,
  detail: string,
  actor: KernelActor,
): Promise<PreviewRow> {
  const moved = await transition(db, PREVIEW_MACHINE, {
    to: 'failed',
    from,
    where: eq(previews.id, row.id),
    set: { reason, detail: detail.slice(-PREVIEW_LIMITS.detail), closedAt: new Date() },
    reason,
    actor,
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await pushBox(tx, row.deviceId, 'preview.stop', { previewId: r.id, why: 'failed' });
      }
    },
  });
  startedAt.delete(row.id);
  return (moved.rows[0] as PreviewRow | undefined) ?? row;
}

/**
 * What the box reports about a preview it was asked to start (`POST …/report`, device credential):
 * the repository's facts when the project has no setting, the dev server up or failed, or the
 * snapshot an approval waits on. A box answers only for the previews it holds.
 */
export async function reportPreview(
  deviceId: string,
  previewId: string,
  report: PreviewReport,
): Promise<PreviewRecord> {
  const row = await previewById(previewId);
  if (!row || row.deviceId !== deviceId) {
    throw refuse('PREVIEW_NOT_FOUND', `no preview ${previewId} is held by this box`);
  }
  const box: KernelActor = { type: 'runner', id: deviceId };
  switch (report.kind) {
    case 'facts':
      return view(await onFacts(row, report.facts, box));
    case 'live': {
      throwRefusal(stateRefusal(row.id, row.state, ['starting', 'live'], 'go live'));
      if (row.state === 'live') return view(row);
      const moved = await transition(db, PREVIEW_MACHINE, {
        to: 'live',
        expect: 'starting',
        where: eq(previews.id, row.id),
        set: { port: report.port, liveAt: new Date() },
        actor: box,
        source: SOURCE,
      });
      return view(movedRow(moved) as PreviewRow);
    }
    case 'failed':
      throwRefusal(stateRefusal(row.id, row.state, ['starting', 'live'], 'fail'));
      return view(await fail(row, ['starting', 'live'], report.reason, report.detail, box));
    case 'snapshot': {
      if (!settleSnapshot(row.id, report)) {
        throw refuse(
          'PREVIEW_NOT_LIVE',
          `no approval of preview ${row.id} waits on a snapshot: one is read only when a person approves`,
        );
      }
      return view(row);
    }
  }
}

async function onFacts(
  row: PreviewRow,
  facts: Extract<PreviewReport, { kind: 'facts' }>['facts'],
  box: KernelActor,
): Promise<PreviewRow> {
  throwRefusal(stateRefusal(row.id, row.state, ['starting'], 'be started from the repository'));
  const detected = detectPreviewSettings(facts);
  if (!detected.ok) return fail(row, ['starting'], detected.reason, detected.detail, box);
  const plan = await planOf(row.projectId);
  const settings = detected.settings;
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(previews)
      .set({
        command: settings.command,
        port: settings.port ?? null,
        idleMinutes: settings.idleMinutes ?? row.idleMinutes,
      })
      .where(eq(previews.id, row.id))
      .returning();
    const next = updated ?? row;
    await pushStart(tx, next, { ...plan, settings });
    return next;
  });
}

/** Close the preview without approving it (BC-9). Needs `project.write`. */
export async function abandonPreview(previewId: string, actor: PreviewActor, why?: string) {
  const row = await rowOf(previewId);
  await accessFor(row.projectId, actor, 'project.write', 'abandon the preview');
  throwRefusal(stateRefusal(row.id, row.state, OPEN_STATES, 'be abandoned'));
  const reason = why?.trim() || 'abandoned by a person';
  const moved = await transition(db, PREVIEW_MACHINE, {
    to: 'abandoned',
    expect: row.state,
    where: eq(previews.id, row.id),
    set: { detail: reason.slice(0, PREVIEW_LIMITS.detail), closedAt: new Date() },
    reason,
    actor: userActor(actor),
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await pushBox(tx, row.deviceId, 'preview.stop', { previewId: r.id, why: 'abandoned' });
      }
    },
  });
  startedAt.delete(row.id);
  return view(movedRow(moved) as PreviewRow);
}

/** A one-time ticket that lets the caller's browser into the preview host (BC-3, BC-4). */
export async function mintPreviewTicket(previewId: string, actor: PreviewActor) {
  const site = siteOrRefuse();
  const row = await rowOf(previewId);
  await accessFor(row.projectId, actor, 'project.read', 'view the preview');
  throwRefusal(stateRefusal(row.id, row.state, OPEN_STATES, 'be viewed'));
  const { token, expiresAt } = await signTicket({ previewId: row.id, userId: actor.userId });
  return {
    url: `${previewOrigin(site, row.slug)}${PREVIEW_ENTER_PATH}?ticket=${encodeURIComponent(token)}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** When this process began watching tunnels: a tunnel lost before it is dated from here. */
let watchingSince: number | null = null;

/**
 * The preview sweep (process timer): abandon the previews whose run ended, idle-close the ones
 * nobody viewed, and fail the ones whose box went away or never answered (BC-9, BC-10).
 */
export async function sweepPreviews(now = Date.now()): Promise<{ moved: number }> {
  watchingSince ??= now;
  let moved = 0;
  const sweeper: KernelActor = { type: 'sweeper' };
  for (const ended of await previewsWhoseRunEnded()) {
    const row = await previewById(ended.id);
    if (!row) continue;
    const result = await transition(db, PREVIEW_MACHINE, {
      to: 'abandoned',
      from: OPEN_STATES.filter((s) => s === row.state),
      where: eq(previews.id, row.id),
      set: { detail: ended.why, closedAt: new Date(now) },
      reason: ended.why,
      actor: sweeper,
      source: `${SOURCE}.sweep`,
      afterWrite: async (tx, rows) => {
        for (const r of rows) {
          await pushBox(tx, row.deviceId, 'preview.stop', { previewId: r.id, why: 'abandoned' });
        }
      },
    });
    moved += result.rows.length;
  }
  for (const row of await previewsIn(['starting', 'live'])) {
    const move = sweepMove(
      {
        state: row.state,
        idleMinutes: row.idleMinutes,
        liveAt: row.liveAt?.getTime() ?? null,
        lastViewedAt: row.lastViewedAt?.getTime() ?? null,
        startedAt: startedAt.get(row.id) ?? Math.max(row.createdAt.getTime(), watchingSince),
        tunnel: tunnelStatus(row.deviceId),
        boxConnected: roomManager.roomSize(deviceRoom(row.deviceId)) > 0,
        watchingSince,
      },
      now,
    );
    if (move === null) continue;
    if (move.to === 'failed') {
      await fail(row, [row.state], move.reason, move.detail, sweeper);
      moved++;
      continue;
    }
    const result = await transition(db, PREVIEW_MACHINE, {
      to: 'idle_closed',
      from: 'live',
      where: eq(previews.id, row.id),
      reason: move.why,
      actor: sweeper,
      source: `${SOURCE}.sweep`,
      afterWrite: async (tx, rows) => {
        for (const r of rows) {
          await pushBox(tx, row.deviceId, 'preview.stop', { previewId: r.id, why: 'idle' });
        }
      },
    });
    startedAt.delete(row.id);
    moved += result.rows.length;
  }
  return { moved };
}
