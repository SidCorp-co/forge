// An outside bot that answers as the binding's own chat account (ISS-775, REQ-77 BC-16): Orbit Babo
// and orbit's connection are one account, so removing the outside bot would remove the channel agent
// itself. Whether a switch is such a one is read here, inside core, and an operator records here that
// the outside process is stopped, which such a switch waits on in place of the removal.

import type { ChannelSwitchView } from '@forge/contracts/support-channel';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { supportChannelSwitches } from '../db/schema-support.js';
import { listBindingsForProject } from '../integrations/index.js';
import { resolveRoomPostAuth } from '../integrations/rocketchat/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { privateRefusal } from './channel.js';
import { no, type Outcome } from './outcome.js';
import { done, switchOf, unknownSwitch, viewOf } from './switch-view.js';

/**
 * An operator records that the outside bot's own process is stopped (ISS-775). Only a switch whose
 * outside bot is the binding's own chat account waits on it; any other outside bot the switch removes
 * from the group itself.
 */
export async function recordOutsideStopped(
  viewer: string,
  projectId: string,
  rid: string,
  note: string,
): Promise<Outcome<ChannelSwitchView>> {
  await requireCan(actorFor(viewer), 'project.admin', projectResource(projectId));
  const refused = privateRefusal<ChannelSwitchView>('/note', note);
  if (refused) return refused;
  const row = await switchOf(projectId, rid);
  if (!row) return unknownSwitch(rid);
  if (row.switchedAt) return done(row);
  const self = await isSelf(projectId, rid, row.outsideBotUserId);
  if (!self) {
    return no(
      'AGENT_SWITCH_OUTSIDE_NOT_SELF',
      '/rid',
      `group ${rid}'s outside bot ${row.outsideBotUsername ?? row.outsideBotUserId} is another chat account than the binding's, and the switch removes it from the group itself; nothing was recorded`,
    );
  }
  const [updated] = await db
    .update(supportChannelSwitches)
    .set({
      outsideIsSelf: true,
      outsideStoppedAt: new Date(),
      outsideStoppedBy: viewer,
      outsideStoppedNote: note,
      updatedAt: new Date(),
    })
    .where(eq(supportChannelSwitches.id, row.id))
    .returning();
  if (!updated) throw new Error(`support: the switch of group ${rid} did not read back`);
  return { ok: true, value: await viewOf(updated) };
}

/** The project's rocketchat binding that names `rid` in `outsideRids`, with or without an agent. */
async function outsideBinding(projectId: string, rid: string) {
  const pairs = (await listBindingsForProject(projectId)).filter(
    (p) => p.binding.provider === 'rocketchat',
  );
  return (
    pairs.find((p) => {
      const c = (p.binding.config ?? {}) as { outsideRids?: unknown };
      return Array.isArray(c.outsideRids) && c.outsideRids.includes(rid);
    }) ?? null
  );
}

/**
 * Whether the outside bot is the chat account the binding's own connection logs in as, compared
 * inside core: the credential is read here and never leaves this function.
 */
export async function isSelf(
  projectId: string,
  rid: string,
  outsideUserId: string,
): Promise<boolean> {
  const pair = await outsideBinding(projectId, rid);
  if (!pair) return false;
  const auth = await resolveRoomPostAuth(pair.binding.connectionId, { rid });
  return auth?.userId === outsideUserId;
}
