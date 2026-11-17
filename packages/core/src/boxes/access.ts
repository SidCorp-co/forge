// What every box write shares (ISS-1276, ADR 0015): the caller, its access to the box's project,
// the refusals, and the frames the device is sent and the room is told, both riding the outbox in
// the transaction of the move that owes them.

import type { BoxControlFrames } from '@forge/contracts/box-wire';
import type { BoxRefusalCode } from '@forge/contracts/boxes';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { Tx } from '../db/client.js';
import type { BoxRow } from '../db/schema-boxes.js';
import { loadProjectAccess } from '../lib/authz.js';
import { refuser } from '../lib/refusal.js';
import type { KernelActor } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { requireDeclaredHeld } from '../permissions/index.js';

export const refuse = refuser<BoxRefusalCode>('BOX_FORBIDDEN');

export const SOURCE = 'boxes';

export interface BoxActor {
  userId: string;
  agency: ActorAgency;
}

export const kernelActorOf = (a: BoxActor): KernelActor => ({
  type: 'user',
  id: a.userId,
  agency: a.agency,
});

export async function accessFor(
  projectId: string,
  actor: BoxActor,
  permission: Parameters<typeof requireDeclaredHeld>[1],
  act: string,
) {
  const access = await loadProjectAccess(projectId, actor.userId, 'box not found');
  requireDeclaredHeld(access, permission, act);
  return access;
}

export async function pushBox<E extends keyof BoxControlFrames>(
  tx: Tx,
  deviceId: string,
  event: E,
  data: BoxControlFrames[E],
): Promise<void> {
  await emitEvent(tx, 'device.pushed', {
    deviceId,
    userId: null,
    event,
    data: data as unknown as Record<string, unknown>,
  });
}

/** The box's room learns it moved or was acted on. */
export async function tellChanged(
  tx: Tx,
  row: Pick<BoxRow, 'id' | 'projectId' | 'issueId' | 'state' | 'heldBy' | 'runId' | 'actSeq'>,
): Promise<void> {
  await emitEvent(tx, 'box.changed', {
    boxId: row.id,
    projectId: row.projectId,
    issueId: row.issueId,
    state: row.state,
    holder:
      row.state === 'person' && row.heldBy
        ? `person:${row.heldBy}`
        : row.state === 'agent'
          ? `agent:${row.runId ?? 'unnamed'}`
          : null,
    actSeq: row.actSeq > 0 ? row.actSeq : null,
    at: new Date().toISOString(),
  });
}
