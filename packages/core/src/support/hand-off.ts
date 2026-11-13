// A room's messages wait for the core process its box is connected to (ISS-1231). Box presence is
// one process's memory (`lib/rooms.ts`), and a room's message is recorded, and its retries timed, by
// the process holding its chat connection's lock: in a core of several processes, or beside a
// container a deploy left running, that is not the process the box dialled, and every hand-over
// there was refused NO_CLAUDE_CLIENT and spent a try while the box sat connected next door. Such a
// process now hands nothing on and spends no try; the room drain of the process the box reads
// (`support.room-drain`, every 2 s in each process) takes the messages. Only a message that waited
// past the bound with no process taking it is handed on as before, and refused by name.

import { boxListensHere } from '../agent-sessions/index.js';
import { oldestReadyAt } from './delivery.js';

/** How long a room's waiting message is left for the process its box reads before it is tried here. */
export const HAND_OFF_WAIT_MS = 60_000;

/** Whether this process leaves the room's waiting messages to the process `deviceId` is connected to. */
export async function leftToBoxProcess(
  roomId: string,
  deviceId: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (boxListensHere(deviceId)) return false;
  const oldest = await oldestReadyAt(roomId);
  return oldest !== null && now.getTime() - oldest.getTime() < HAND_OFF_WAIT_MS;
}
