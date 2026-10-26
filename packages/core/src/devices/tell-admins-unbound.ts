/**
 * A room whose readers cannot bind a box is answered in its own voice; the sentence naming the box
 * goes to the project's admins as one open condition per device, which a bind of it resolves.
 */

import { usersHoldingOnEvery } from '../lib/authz.js';
import { logger } from '../logger.js';
import { emitNotification } from '../notifications/emit.js';
import { unboundNoticeKey } from './unbound-notice.js';

export async function tellAdminsDeviceUnbound(args: {
  projectId: string;
  deviceId: string;
  refusal: string;
  where: string;
}): Promise<void> {
  const admins = await usersHoldingOnEvery([args.projectId], 'admin');
  if (admins.length === 0) {
    logger.warn(
      { projectId: args.projectId, deviceId: args.deviceId, refusal: args.refusal },
      'device-not-bound: the project has no admin to tell',
    );
    return;
  }
  await emitNotification({
    recipients: admins,
    projectId: args.projectId,
    type: 'ops_alert',
    severity: 'warning',
    title: `${args.where} could not answer: the project's runner is not bound`,
    body: `${args.refusal} Until then the room is told the question cannot be looked into yet.`,
    resolutionKey: unboundNoticeKey(args.projectId, args.deviceId),
  });
}
