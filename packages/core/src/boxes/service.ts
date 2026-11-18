// A box's lifecycle writes (ISS-1276, ADR 0015): open (a request that starts now, takes a warm box,
// or waits on the device's health), close, take and release. Every state is written by the kernel
// transition, so `kernel_transitions` records who moved it and when; every frame the device is sent
// rides the outbox in the move's own transaction.

import {
  BOX_MACHINE,
  type BoxMode,
  type BoxRecord,
  type OpenBoxRequest,
} from '@forge/contracts/boxes';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { type BoxRow, boxes } from '../db/schema-boxes.js';
import { type BoxDevice, modeReportOf, projectBoxDevices, runDeviceOf } from '../devices/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { movedRow, transition } from '../lifecycle/index.js';
import {
  accessFor,
  type BoxActor,
  kernelActorOf,
  pushBox,
  refuse,
  SOURCE,
  tellChanged,
} from './access.js';
import { allocateDevice } from './allocate.js';
import { handBack } from './hold.js';
import { boxById, boxRecord, personName } from './read.js';
import { deviceModeFault, modeFault } from './rules.js';

export async function rowOf(id: string): Promise<BoxRow> {
  const row = await boxById(id);
  if (!row) throw refuse('BOX_NOT_FOUND', `no box ${id}`);
  return row;
}

/** The box's project, for a caller that must hold `permission` on it; a warm box is no one's yet. */
async function ownedRow(id: string, actor: BoxActor, act: string) {
  const row = await rowOf(id);
  if (row.projectId === null) throw refuse('BOX_NOT_FOUND', `no box ${id} is any project's`);
  await accessFor(row.projectId, actor, 'project.write', act);
  return row as BoxRow & { projectId: string };
}

const freeMemory = (d: BoxDevice) =>
  d.health ? d.health.report.memory.availableMb - d.health.report.memory.reserveMb : -1;

/** The device the box runs on: the one named, else the run's, else the project's roomiest serving it. */
async function deviceFor(
  projectId: string,
  mode: BoxMode,
  req: OpenBoxRequest,
): Promise<BoxDevice> {
  const bound = await projectBoxDevices(projectId);
  const pinned = req.deviceId ?? (req.runId ? await runDeviceOf(req.runId, projectId) : null);
  if (pinned !== null) {
    const device = bound.find((d) => d.id === pinned) ?? null;
    if (!device) {
      throw refuse(
        'BOX_NO_DEVICE',
        `device ${pinned} is not bound to this project, so no box of it runs there: name one of its devices, or none`,
        req.deviceId ? '/deviceId' : '/runId',
      );
    }
    return device;
  }
  if (bound.length === 0) {
    throw refuse(
      'BOX_NO_DEVICE',
      'no device is bound to this project, so no box can run for it: bind a runner to it first',
    );
  }
  const serving = bound.filter((d) => modeReportOf(d.health, mode)?.serves === true);
  const pool = serving.length > 0 ? serving : bound;
  return [...pool].sort(
    (a, b) => Number(b.online) - Number(a.online) || freeMemory(b) - freeMemory(a),
  )[0] as BoxDevice;
}

async function issueOf(projectId: string, issueId: string): Promise<void> {
  const [row] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.projectId, projectId)))
    .limit(1);
  if (!row) throw refuse('BOX_NOT_FOUND', `no issue ${issueId} in this project`, '/issueId');
}

/**
 * Open a box. Core infers nothing about which criterion needs one: the caller names it. A request
 * that cannot start now is kept on the record as `waiting` and refused `BOX_SLOT_UNAVAILABLE` with
 * its place and why; it starts on its own when the device's health returns.
 */
export async function openBox(
  actor: BoxActor,
  projectId: string,
  req: OpenBoxRequest,
): Promise<BoxRecord> {
  const unserved = modeFault(req.mode);
  if (unserved) throw refuse(unserved.code, unserved.detail, '/mode');
  const mode = req.mode as BoxMode;
  await accessFor(projectId, actor, 'project.write', 'open a box');
  const asPerson = req.asPerson === true;
  if (asPerson && actor.agency !== 'human') {
    throw refuse(
      'BOX_FORBIDDEN',
      'a box opened to test by hand is a person’s: an agent opens one it drives',
      '/asPerson',
    );
  }
  if (req.issueId) await issueOf(projectId, req.issueId);
  const device = await deviceFor(projectId, mode, req);
  const fault = deviceModeFault(mode, modeReportOf(device.health, mode), device.health !== null);
  if (fault) throw refuse(fault.code, fault.detail, '/mode');

  const id = await db.transaction(async (tx) => {
    await lockXact(tx, 'boxes', device.id);
    const [warm] =
      req.viewport === undefined
        ? await tx
            .select()
            .from(boxes)
            .where(
              and(eq(boxes.deviceId, device.id), eq(boxes.mode, mode), eq(boxes.state, 'warm')),
            )
            .limit(1)
        : [];
    const now = new Date();
    const fields = {
      projectId,
      issueId: req.issueId ?? null,
      criterion: req.criterion ?? null,
      runId: asPerson ? null : (req.runId ?? null),
      openedAs: asPerson ? ('person' as const) : ('agent' as const),
      url: req.url ?? null,
      createdBy: actor.userId,
    };
    if (warm) {
      const moved = await transition(tx, BOX_MACHINE, {
        to: asPerson ? 'person' : 'agent',
        expect: 'warm',
        where: eq(boxes.id, warm.id),
        set: {
          ...fields,
          ...(asPerson ? { heldBy: actor.userId, heldSince: now, lastInputAt: now } : {}),
          askedAt: now,
        },
        actor: kernelActorOf(actor),
        source: SOURCE,
        afterWrite: async (t, rows) => {
          for (const r of rows) {
            await pushBox(t, device.id, 'box.assign', { boxId: r.id, url: req.url ?? null });
            await tellChanged(t, {
              ...warm,
              ...fields,
              ...r,
              state: asPerson ? 'person' : 'agent',
            });
          }
        },
      });
      return (movedRow(moved) as BoxRow).id;
    }
    const [row] = await tx
      .insert(boxes)
      .values({
        ...fields,
        deviceId: device.id,
        mode,
        state: 'waiting',
        viewport: req.viewport ?? null,
      })
      .returning();
    if (!row) throw new Error('boxes: insert returned no row');
    await tellChanged(tx, row);
    return row.id;
  });

  await allocateDevice(device.id);
  const row = await rowOf(id);
  if (row.state === 'waiting') {
    const place = row.queue;
    throw refuse(
      'BOX_SLOT_UNAVAILABLE',
      `box ${row.id} waits${place ? `, ${ordinal(place.position)} in this device's queue, because ${place.reason}` : ' for this device to report its health'}. No count of boxes refused it: it starts on its own when the device's health leaves room. Read it (GET /api/boxes/${row.id}) until it stands at ${asPerson ? 'person' : 'agent'}, or close it (POST /api/boxes/${row.id}/close)`,
    );
  }
  return boxRecord(row);
}

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export async function readBox(id: string, actor: BoxActor): Promise<BoxRecord> {
  const row = await rowOf(id);
  if (row.projectId === null) throw refuse('BOX_NOT_FOUND', `no box ${id} is any project's`);
  await accessFor(row.projectId, actor, 'project.read', 'read a box');
  return boxRecord(row);
}

/**
 * Close a box: the device reaps every process it started; its recording stays until the issue ends.
 * A person's hold ends with it in the same write (`boxes_held_chk`, ISS-1317).
 */
export async function closeBox(id: string, actor: BoxActor, reason?: string): Promise<BoxRecord> {
  const row = await ownedRow(id, actor, 'close a box');
  if (row.state === 'closed' || row.state === 'failed') return boxRecord(row);
  const moved = await transition(db, BOX_MACHINE, {
    to: 'closed',
    expect: row.state,
    where: eq(boxes.id, row.id),
    set: {
      closedAt: new Date(),
      queue: null,
      heldBy: null,
      heldSince: null,
      recordingState: row.recordingState === 'recording' ? 'kept' : row.recordingState,
    },
    reason: reason ?? null,
    actor: kernelActorOf(actor),
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        if (row.state !== 'waiting') {
          await pushBox(tx, row.deviceId, 'box.close', { boxId: r.id, why: 'done' });
        }
        await tellChanged(tx, { ...row, ...r, state: 'closed' });
      }
    },
  });
  await allocateDevice(row.deviceId);
  return boxRecord(movedRow(moved) as BoxRow);
}

/** A person takes control: from now the agent's state-changing acts are refused `BOX_HELD_BY_PERSON`. */
export async function takeBox(id: string, actor: BoxActor): Promise<BoxRecord> {
  if (actor.agency !== 'human') {
    throw refuse(
      'BOX_FORBIDDEN',
      'take control is a person’s act: an agent drives the box it holds',
    );
  }
  const row = await ownedRow(id, actor, 'take control of a box');
  if (row.state === 'person') {
    if (row.heldBy === actor.userId) return boxRecord(row);
    const name = row.heldBy ? ((await personName(row.heldBy)) ?? row.heldBy) : 'a person';
    throw refuse(
      'BOX_NOT_HELD',
      `${name} has held this box since ${row.heldSince?.toISOString() ?? 'now'}: watch it until they hand it back`,
    );
  }
  if (row.state !== 'agent') {
    throw refuse('BOX_NOT_READY', `the box is ${row.state}: take control once it runs`);
  }
  const now = new Date();
  const name = await personName(actor.userId);
  const moved = await transition(db, BOX_MACHINE, {
    to: 'person',
    expect: 'agent',
    where: eq(boxes.id, row.id),
    set: { heldBy: actor.userId, heldSince: now, lastInputAt: now },
    actor: kernelActorOf(actor),
    source: SOURCE,
    afterWrite: async (tx, rows) => {
      for (const r of rows) {
        await pushBox(tx, row.deviceId, 'box.take', { boxId: r.id, userId: actor.userId, name });
        await tellChanged(tx, { ...row, ...r, state: 'person', heldBy: actor.userId });
      }
    },
  });
  return boxRecord(movedRow(moved) as BoxRow);
}

/** The holder hands back; the agent reads what the person did in the act feed. */
export async function releaseBox(id: string, actor: BoxActor): Promise<BoxRecord> {
  const row = await ownedRow(id, actor, 'hand a box back');
  if (row.state === 'agent') return boxRecord(row);
  if (row.state !== 'person' || row.heldBy !== actor.userId) {
    throw refuse(
      'BOX_NOT_HELD',
      `you do not hold this box (it stands at ${row.state}): only its holder hands it back`,
    );
  }
  return handBack(row, 'released', kernelActorOf(actor));
}
