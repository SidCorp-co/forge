// The box a room's act runs on (REQ-75 r5): the one its session runs on, so a command and a build
// run where the room's working copy and the box's own SSH and git credentials are. One that does not
// declare what the act needs is refused by name: an older runner never answers the frame.

import { SUPPORT_BOX_CAPABILITIES } from '@forge/contracts/support';
import { boxLacks, sessionRowById } from '../agent-sessions/index.js';
import { no, type Outcome } from './outcome.js';
import type { RoomRow } from './store.js';

export async function boxOfRoom(
  room: RoomRow,
  need: keyof typeof SUPPORT_BOX_CAPABILITIES,
): Promise<Outcome<string>> {
  const session = room.sessionId ? await sessionRowById(room.sessionId) : null;
  const deviceId = session?.deviceId ?? null;
  if (!deviceId) {
    return no(
      'SUPPORT_COMMAND_FAILED',
      '/action',
      "this room's session has not run on a box yet, so no box holds its working copy or can reach a host for it",
    );
  }
  const capability = SUPPORT_BOX_CAPABILITIES[need];
  const box = await boxLacks(deviceId, [capability]);
  if (!box) {
    return no('SUPPORT_COMMAND_FAILED', '/action', `the box ${deviceId} this room ran on is gone`);
  }
  if (box.lacks.length > 0) {
    return no(
      'SUPPORT_COMMAND_FAILED',
      '/action',
      `the box ${box.name} this room runs on does not declare ${capability}: its forge-runner predates it (\`forge-runner update\` on the box)`,
    );
  }
  return { ok: true, value: deviceId };
}
