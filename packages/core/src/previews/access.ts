// What every preview write shares (REQ-39): the caller's access, the row it names, the refusals,
// and the frames the box is sent, which ride the outbox in the transaction of the move that owes them.

import type { ActorAgency } from '@forge/contracts/permissions';
import {
  PREVIEW_LIMITS,
  type PreviewControlFrames,
  type PreviewRefusalCode,
} from '@forge/contracts/preview';
import type { Tx } from '../db/client.js';
import type { PreviewRow } from '../db/schema-previews.js';
import { loadProjectAccess } from '../lib/authz.js';
import { type Refusal, RefusalError, refuser } from '../lib/refusal.js';
import type { KernelActor } from '../lifecycle/index.js';
import { emitEvent } from '../outbox/index.js';
import { requireHeld } from '../permissions/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { type PreviewSite, previewSite } from './domain.js';
import { previewById, previewView } from './read.js';
import { type PreviewPlan, previewPlan } from './rules.js';

export const refuse = refuser<PreviewRefusalCode>('PREVIEW_FORBIDDEN');

export interface PreviewActor {
  userId: string;
  agency: ActorAgency;
}

export const SOURCE = 'previews';

export const userActor = (a: PreviewActor): KernelActor => ({
  type: 'user',
  id: a.userId,
  agency: a.agency,
});

export function siteOrRefuse(): PreviewSite {
  const site = previewSite();
  if (site === null) {
    throw refuse(
      'PREVIEW_DOMAIN_UNCONFIGURED',
      'this Forge serves no previews: PREVIEW_DOMAIN is unset. Its operator names a separate wildcard site (another site from Forge, with wildcard DNS and TLS to core) and sets PREVIEW_DOMAIN',
    );
  }
  return site;
}

export function throwRefusal(r: Refusal | null): void {
  if (r) throw new RefusalError([r], r.code);
}

export async function pushBox<E extends keyof PreviewControlFrames>(
  tx: Tx,
  deviceId: string,
  event: E,
  data: PreviewControlFrames[E],
): Promise<void> {
  await emitEvent(tx, 'device.pushed', {
    deviceId,
    userId: null,
    event,
    data: data as unknown as Record<string, unknown>,
  });
}

/** When each preview was last asked to start, in this process: the sweep dates a silent box from it. */
export const startedAt = new Map<string, number>();

export async function pushStart(tx: Tx, row: PreviewRow, plan: PreviewPlan): Promise<void> {
  startedAt.set(row.id, Date.now());
  await pushBox(tx, row.deviceId, 'preview.start', {
    previewId: row.id,
    sessionId: row.sessionId,
    settings: plan.settings,
    env: plan.env,
    readyTimeoutSeconds: PREVIEW_LIMITS.readyTimeoutSeconds,
  });
}

export async function planOf(projectId: string): Promise<PreviewPlan> {
  const held = await readProjectDocument(projectId);
  const planned = previewPlan(held?.document ?? null);
  if (!planned.ok) throw new RefusalError([planned.refusal], planned.refusal.code);
  return planned.plan;
}

export async function accessFor(
  projectId: string,
  actor: PreviewActor,
  permission: Parameters<typeof requireHeld>[1],
  act: string,
) {
  const access = await loadProjectAccess(projectId, actor.userId, 'preview not found');
  requireHeld(access, permission, act);
  return access;
}

export async function rowOf(previewId: string): Promise<PreviewRow> {
  const row = await previewById(previewId);
  if (!row) throw refuse('PREVIEW_NOT_FOUND', `no preview ${previewId}`);
  return row;
}

export const view = (row: PreviewRow) => previewView(row, siteOrRefuse());
