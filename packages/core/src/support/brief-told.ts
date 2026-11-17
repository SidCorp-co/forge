// A room's session is told the brief this build renders for it, and told it again whenever that brief
// changes (ISS-1251 c8, c11). A room session stays resident for days: Forge-Communicate's operations
// room answered on 17/11 in a session started on 04/11 and last briefed on 15/11, when its role
// changed. A brief told only on a cold start, or on a role or tools change, never reached it, so none
// of the lines ISS-1243, ISS-1250 and ISS-1251 added (read who wrote a message, keep the member
// record, raise a missing grant in the technical channel) was in what it followed: its record stayed
// empty, and it told the owner what its role could not do and sent him to a screen, as the 15/11
// brief taught ("say in the thread what the refusal says and who can do it instead"). What a session
// was told is kept as a key on its row, so a core restart forgets nothing. The channel record is left
// out of the key: its own news is told apart when it changes (REQ-75 r6 BC-41).

import { createHash } from 'node:crypto';
import type { SupportRoomConfig } from '@forge/contracts/support';
import { mergeSessionMetadata } from '../agent-sessions/index.js';
import { type BoundSupportTool, supportApisOf } from '../integrations/support-api/index.js';
import { moduleMapLines } from '../labels/index.js';
import { moduleLinesText } from '../lib/door-catalog.js';
import { briefChannel } from './channel-read.js';
import type { FollowedCheckout } from './dispatch.js';
import { answersOfConfig, readersOfConfig, supportConfigOf } from './grants.js';
import { operationsBrief } from './ops-prompt.js';
import { roleOfRoom } from './ops-role.js';
import { projectsInScope } from './ops-scope.js';
import { agentOpening, supportBrief } from './prompt.js';
import type { SessionRow } from './room-session.js';
import { type RoomRow, roomsOfSession } from './store.js';

/** The session metadata key holding the key of the brief the session was last told. */
export const BRIEF_TOLD_KEY = 'briefTold';

/** The line a resident session is told its changed brief under. */
export const BRIEF_CHANGED_LEAD =
  'Your brief changed since it was last told to you; from now on it reads:';

/** What a brief is known by: a hash of its text, so a changed line is a changed key. */
export const briefKeyOf = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 32);

/** The key of the brief the session was last told, or null where none was kept (a session briefed before ISS-1251). */
export function briefToldOf(session: Pick<SessionRow, 'metadata'>): string | null {
  const meta = session.metadata as Record<string, unknown> | null;
  const told = meta?.[BRIEF_TOLD_KEY];
  return typeof told === 'string' ? told : null;
}

/**
 * A room session's brief: a support group's (the product, its granted tools), a channel agent's, or an
 * operations room's (its role's persona and grants, its reach); with the channel record, as a cold
 * session is told it, or without it, as its key is taken. An operations room whose bot has no role it
 * can read is not briefed at all: the turn throws, naming why, and its messages wait.
 */
export async function briefOf(
  room: RoomRow,
  projectName: string,
  followed: readonly FollowedCheckout[],
  withChannel = true,
): Promise<string> {
  if (room.kind === 'operations') {
    const role = await roleOfRoom(room);
    if (!role.ok) throw new Error(`support: ${role.refusals[0]?.detail ?? 'no role'}`);
    const brief = operationsBrief({
      role: role.value,
      scope: room.scope ?? 'project',
      reach: await projectsInScope(room),
    });
    return withChannel ? [brief, await briefChannel(room)].join('\n\n') : brief;
  }
  const { tools } = await supportApisOf(room.projectId);
  const config = await supportConfigOf(room);
  if (room.kind === 'agent') {
    return agentBriefOf(room, projectName, tools, config, followed, withChannel);
  }
  return supportBrief({
    projectName,
    product: config?.product ?? null,
    tools,
    config,
    channel: withChannel ? await briefChannel(room) : null,
    modules: moduleLinesText(await moduleMapLines(room.projectId), 'bot'),
  });
}

/** A channel agent's brief (REQ-77): one for every group its session answers, each group's channel record after it. */
async function agentBriefOf(
  room: RoomRow,
  projectName: string,
  tools: readonly BoundSupportTool[],
  config: SupportRoomConfig | null,
  followed: readonly FollowedCheckout[],
  withChannel: boolean,
): Promise<string> {
  const rooms = room.sessionId ? await roomsOfSession(room.sessionId) : [room];
  const records = withChannel
    ? (await Promise.all(rooms.map((r) => briefChannel(r)))).filter(Boolean)
    : [];
  return supportBrief({
    projectName,
    product: config?.product ?? null,
    tools,
    config,
    channel: records.join('\n\n') || null,
    modules: moduleLinesText(await moduleMapLines(room.projectId), 'bot'),
    opening: agentOpening({
      projectName,
      product: config?.product ?? null,
      channels: rooms.map((r) => r.rid),
      ownerMode: Boolean(config?.grants?.abilities.includes('owner_mode')),
      ownerRoom: config?.ownerRoom ?? null,
      followed,
      // each group's own readers and answers, where the binding sets them per group (ISS-874)
      rooms: config?.rooms
        ? rooms.map((r) => ({
            rid: r.rid,
            readers: readersOfConfig(r, config),
            answers: answersOfConfig(r, config),
          }))
        : [],
    }),
  });
}

/** The key of the brief this build renders for the room's session now, its channel record left out. */
const keyNow = async (room: RoomRow, projectName: string, followed: readonly FollowedCheckout[]) =>
  briefKeyOf(await briefOf(room, projectName, followed, false));

/** Whether the session was told some other brief than the one this build renders for it now. */
export async function briefStale(
  room: RoomRow,
  session: Pick<SessionRow, 'metadata'>,
  projectName: string,
  followed: readonly FollowedCheckout[],
): Promise<boolean> {
  return briefToldOf(session) !== (await keyNow(room, projectName, followed));
}

/** A cold session's brief, whole, kept as told on its row. */
export async function coldBrief(
  room: RoomRow,
  session: Pick<SessionRow, 'id'>,
  projectName: string,
  followed: readonly FollowedCheckout[],
): Promise<string> {
  const brief = await briefOf(room, projectName, followed);
  await mergeSessionMetadata(session.id, {
    [BRIEF_TOLD_KEY]: await keyNow(room, projectName, followed),
  });
  return brief;
}

/**
 * What a resident session is told before its turn where the brief it holds is not the one this build
 * renders for it: the whole brief again, under one lead line, kept as told; null where it holds it.
 */
export async function briefNews(
  room: RoomRow,
  session: Pick<SessionRow, 'id' | 'metadata'>,
  projectName: string,
  followed: readonly FollowedCheckout[],
): Promise<string | null> {
  const key = await keyNow(room, projectName, followed);
  if (briefToldOf(session) === key) return null;
  const brief = await briefOf(room, projectName, followed);
  await mergeSessionMetadata(session.id, { [BRIEF_TOLD_KEY]: key });
  return `${BRIEF_CHANGED_LEAD}\n\n${brief}`;
}
