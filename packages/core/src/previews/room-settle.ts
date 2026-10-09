// Settling a POC room (REQ-44 BC-2, BC-7, BC-8): a person settles what the room settled. Refused by
// name before anything moves where there is no dev branch, where the dev branch is main or
// production's, where the requirement draws no preview picture, or where the preview sleeps. Then the
// room agent takes out of the branch what was not settled (one trim turn), the box commits and merges
// the branch `--no-ff` straight into the dev branch with no gate in front of it, and, once the merge
// stands, the settled items become the requirement's criteria and the page its picture, and a
// follow-up issue verifies, reviews and cleans the merge after the fact.

import { ROOM_MACHINE, type Room, type SettleRoomRequest } from '@forge/contracts/poc-room';
import {
  type KeptPreviewContent,
  PREVIEW_IDEA_LIMITS,
  PREVIEW_SNAPSHOT_LIMITS,
  type PreviewReport,
} from '@forge/contracts/preview';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  type PocRoomRow,
  pocRoomItems,
  pocRooms,
  type RoomSettleRecord,
} from '../db/schema-poc-rooms.js';
import { logger } from '../lib/logger.js';
import { isRefusal, RefusalError } from '../lib/refusal.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { type PreviewActor, refuse, rowOf, userActor } from './access.js';
import { askSnapshot } from './approve.js';
import type { KeptAbout } from './keep-port.js';
import { scrubEvents } from './recordings.js';
import { roomSettleWriter } from './room-port.js';
import { inRoomOrder, insertTurn, readRoom, refuseRoom, roomRow } from './rooms.js';
import { roomLanding } from './rules.js';
import { closeAbandoned } from './service.js';
import { itemOf } from './subject-reads.js';
import { deliverToSketch } from './subjects.js';

const SOURCE = 'poc-rooms.settle';

async function aboutOf(room: PocRoomRow): Promise<KeptAbout> {
  if (room.aboutKind === 'requirement') return { kind: 'requirement', key: room.aboutKey };
  const item = await itemOf(room.projectId, room.aboutKey);
  return { kind: 'feedback', key: room.aboutKey, title: item?.title ?? room.aboutKey };
}

/** What the agent is told before a merge: keep what was settled, take out the rest. */
export function trimBrief(settled: readonly string[], unsettled: readonly string[]): string {
  return [
    'This room is being settled. Keep exactly what these settled items need, as they show now:',
    ...settled.map((s) => `- ${s}`),
    '',
    'Take out of this branch everything else that was asked in this room and not settled:',
    ...unsettled.map((s) => `- ${s}`),
    '',
    'Edit the source only: do not build, test, push or merge; the room merges the branch itself. Say in one sentence what you took out.',
  ].join('\n');
}

/**
 * Settle the room (needs project.write): every refusal is named before the room moves; then the
 * room is `settling` and the merge follows the agent's trim, or at once where nothing was left
 * unsettled.
 */
export async function settleRoom(
  roomId: string,
  request: SettleRoomRequest,
  actor: PreviewActor,
): Promise<Room> {
  const room = await roomRow(roomId);
  const viewed = await readRoom(room.id, actor);
  if (!viewed.canWrite) {
    throw refuseRoom(
      'ROOM_FORBIDDEN',
      'project.write on this project is needed to settle the POC room',
    );
  }
  if (room.state !== 'open') {
    throw refuseRoom(
      'ROOM_CLOSED',
      `POC room ${room.id} is ${room.state}: only an open room is settled`,
    );
  }
  const items = viewed.items;
  if (items.length === 0) {
    throw refuseRoom(
      'ROOM_NOTHING_SETTLED',
      `POC room ${room.id} has no settled item: settle what a turn showed first, and only what is settled is merged`,
    );
  }
  const preview = await rowOf(room.previewId);
  if (preview.state !== 'live') {
    throw refuseRoom(
      'ROOM_ASLEEP',
      `the room's preview is ${preview.state}${preview.reason ? ` (${preview.reason})` : ''}: the box merges from a live preview, so join the room to wake it, then settle`,
    );
  }
  const landing = roomLanding((await readProjectDocument(room.projectId))?.document ?? null);
  if (!landing.ok) throw refuseRoom(landing.code, landing.detail);
  const about = await aboutOf(room);
  const unfit = await roomSettleWriter().refusal({ projectId: room.projectId, about });
  if (unfit)
    throw new RefusalError(
      [{ code: unfit.code, path: '', detail: unfit.detail }],
      'ROOM_FORBIDDEN',
    );
  const bytes = Buffer.byteLength(JSON.stringify(request.snapshot));
  if (bytes > PREVIEW_SNAPSHOT_LIMITS.bytes) {
    throw refuse(
      'PREVIEW_KEEP_SNAPSHOT_INVALID',
      `the page snapshot is ${bytes} bytes, over the ${PREVIEW_SNAPSHOT_LIMITS.bytes} a picture holds: settle from a smaller page`,
      '/snapshot',
    );
  }
  const record: RoomSettleRecord = {
    into: landing.into,
    askedBy: actor.userId,
    askedAt: new Date().toISOString(),
    alt: request.alt,
    // scrubbed as it is kept: an abandon before the picture is drawn keeps no raw page
    snapshot: scrubEvents(request.snapshot) as RoomSettleRecord['snapshot'],
    mergeAskedAt: null,
    mergeSha: null,
    requirement: null,
    revision: null,
    issueId: null,
    refusals: [],
  };
  movedRow(
    await transition(db, ROOM_MACHINE, {
      to: 'settling',
      expect: 'open',
      where: eq(pocRooms.id, room.id),
      set: { settle: record, detail: null },
      actor: userActor(actor),
      source: SOURCE,
    }),
  );
  const settledTurns = new Set(items.map((i) => i.turnId));
  const unsettled = viewed.turns
    .filter((t) => t.kind === 'ask' && !settledTurns.has(t.id))
    .map((t) => t.ask);
  if (unsettled.length > 0) {
    const text = trimBrief(
      items.map((i) => i.text),
      unsettled,
    );
    try {
      await insertTurn(room.id, 'trim', null, text);
      await deliverToSketch(preview, null, actor, text);
    } catch (err) {
      // nothing was merged: the room goes back to open, naming why, rather than standing at settling
      await backToOpen(room, `the trim before the merge did not reach the room's agent: ${(err as Error).message}`);
      throw err;
    }
  } else {
    void inRoomOrder(room.id, () => runSettle(room.id));
  }
  return readRoom(room.id, actor);
}

async function backToOpen(room: PocRoomRow, detail: string): Promise<void> {
  await transition(db, ROOM_MACHINE, {
    to: 'open',
    expect: 'settling',
    where: eq(pocRooms.id, room.id),
    set: { settle: null, detail },
    actor: { type: 'system' },
    source: SOURCE,
  });
}

type MergeReport = Extract<PreviewReport, { kind: 'snapshot' }>;

/**
 * The merge, once the agent's trim showed (or at once). Runs in the room's order, so the snapshot it
 * waits on is its own. The ask is recorded on the settle before it is sent: from then on only the
 * box's report decides the room. A report that comes after core stopped waiting still settles it
 * (`settleFromLateReport`), so a merge that landed late is never told as one that did not.
 */
export async function runSettle(roomId: string): Promise<void> {
  const room = await roomRow(roomId);
  const settle = room.settle;
  if (room.state !== 'settling' || !settle || settle.mergeAskedAt) return;
  const preview = await rowOf(room.previewId);
  const items = await db
    .select()
    .from(pocRoomItems)
    .where(eq(pocRoomItems.roomId, room.id))
    .orderBy(asc(pocRoomItems.settledAt));
  const message = [
    `Merge POC room ${room.id} (${room.branch}) into ${settle.into}`,
    '',
    `Settled for ${room.aboutKey}:`,
    ...items.map((i) => `- ${i.text}`),
    '',
    'Merged straight from the room; verify, review and code standards follow as their own issue (REQ-44 BC-8).',
  ].join('\n');
  const asked = { ...settle, mergeAskedAt: new Date().toISOString() };
  await db
    .update(pocRooms)
    .set({ settle: asked })
    .where(and(eq(pocRooms.id, room.id), eq(pocRooms.state, 'settling')));
  let taken: MergeReport;
  try {
    taken = await askSnapshot(preview, true, { into: settle.into, message });
  } catch (err) {
    if (isRefusal(err, 'PREVIEW_SNAPSHOT_UNAVAILABLE')) {
      // the ask went out and no answer came in time: the merge may still land, so the room waits on
      // the box's report instead of saying nothing merged
      await db
        .update(pocRooms)
        .set({
          detail: `the box was asked to merge into ${settle.into} at ${asked.mergeAskedAt} and has not reported; the room settles or reopens on its report`,
        })
        .where(and(eq(pocRooms.id, room.id), eq(pocRooms.state, 'settling')));
      logger.warn({ roomId }, 'poc-rooms: the merge report is late; the room waits on it');
      return;
    }
    await backToOpen(room, `the box was not asked to merge the branch: ${(err as Error).message}`);
    return;
  }
  await finishSettle(room.id, taken);
}

/**
 * A snapshot report that names a merge outcome, for a room whose merge was asked and no waiter holds:
 * the box answered after core stopped waiting. False where the report is not that room's merge.
 */
export async function settleFromLateReport(previewId: string, report: MergeReport): Promise<boolean> {
  if (!report.merged && !report.mergeRefused) return false;
  const [room] = await db.select().from(pocRooms).where(eq(pocRooms.previewId, previewId));
  if (!room || room.state !== 'settling' || !room.settle?.mergeAskedAt) return false;
  await inRoomOrder(room.id, () => finishSettle(room.id, report));
  return true;
}

/**
 * What follows the box's merge report. A merge that did not land puts the room back to open, naming
 * git's words; what the requirement or issue write refuses after the merge is kept on the settle by
 * its code.
 */
async function finishSettle(roomId: string, taken: MergeReport): Promise<void> {
  const room = await roomRow(roomId);
  const settle = room.settle;
  if (room.state !== 'settling' || !settle) return;
  const preview = await rowOf(room.previewId);
  const items = await db
    .select()
    .from(pocRoomItems)
    .where(eq(pocRoomItems.roomId, room.id))
    .orderBy(asc(pocRoomItems.settledAt));
  if (!taken.merged || !taken.head) {
    await backToOpen(
      room,
      taken.mergeRefused
        ? `the merge into ${settle.into} did not land, and nothing was written: ${taken.mergeRefused}`
        : `the box reported no merge into ${settle.into}: it runs a forge-runner that predates rooms (forge-runner update); nothing was written`,
    );
    return;
  }
  const asked = items.map((i) => i.text.slice(0, PREVIEW_IDEA_LIMITS.brief)).slice(0, 50);
  const content: KeptPreviewContent = {
    previewId: preview.id,
    branch: room.branch,
    head: taken.head,
    base: taken.base,
    patchId: taken.patchId,
    files: taken.files,
    asked,
    snapshot: scrubEvents(settle.snapshot ?? []) as KeptPreviewContent['snapshot'],
  };
  let written: Awaited<ReturnType<ReturnType<typeof roomSettleWriter>['write']>>;
  try {
    written = await roomSettleWriter().write({
      projectId: room.projectId,
      actor: { userId: settle.askedBy, agency: 'human' },
      about: await aboutOf(room),
      items: items.map((i) => ({ text: i.text, commit: i.commitSha })),
      alt: settle.alt,
      content,
      merge: { into: settle.into, sha: taken.merged.sha, branch: room.branch, roomId: room.id },
    });
  } catch (err) {
    logger.error({ err, roomId }, 'poc-rooms: the settle write failed after the merge');
    written = {
      requirement: null,
      revision: null,
      issue: null,
      refusals: [{ code: 'ROOM_SETTLE_WRITE_FAILED', detail: (err as Error).message }],
    };
  }
  movedRow(
    await transition(db, ROOM_MACHINE, {
    to: 'settled',
    expect: 'settling',
    where: eq(pocRooms.id, room.id),
    set: {
      settle: {
        ...settle,
        snapshot: null,
        mergeSha: taken.merged.sha,
        requirement: written.requirement,
        revision: written.revision,
        issueId: written.issue?.id ?? null,
        refusals: written.refusals,
      },
      closedAt: new Date(),
    },
    actor: { type: 'system' },
    source: SOURCE,
  }),
  );
  await closeAbandoned(
    await rowOf(room.previewId),
    { userId: settle.askedBy, agency: 'human' },
    `the POC room was settled: merged into ${settle.into} as ${taken.merged.sha}`,
    true,
  );
}
