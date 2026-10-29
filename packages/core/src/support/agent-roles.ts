// The agent sessions a project lists by role (REQ-75 r7 BC-42..BC-44): its live masters and the agent
// answering each bound channel, Forge's own bot or an agent outside Forge, each with its box and the
// address it is reached at now. Nothing here is stored for it: a master and a channel bot are read
// off the sessions Forge placed, so a restart that places a new session moves the address with it,
// and an outside agent's address is the one it last declared on its channel. A peer finds another by
// role here, never by a name it kept.

import {
  type AgentRoleView,
  CHANNEL_AGENT_ROLE,
  type ChannelAgentWrite,
  forgeSessionAddress,
} from '@forge/contracts/support-channel';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { liveMasterSessions } from '../masters/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { privateRefusal } from './channel.js';
import {
  answeredOutside,
  boundRidsOf,
  type ChannelRow,
  channelIsBound,
  channelOf,
  declareChannelAgent,
  ensureChannel,
} from './channel-store.js';
import { no, type Outcome } from './outcome.js';
import { roomIsBound } from './rooms.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];
const iso = (t: string | Date) => new Date(t).toISOString();

/** Forge's own bot answering the group: the session of a room its binding still names. */
async function forgeBotOf(projectId: string, rid: string): Promise<AgentRoleView | null> {
  const rooms = rowsOf<{
    binding_id: string;
    kind: string;
    session_id: string;
    box: string | null;
    terminal: string | null;
    since: string | Date;
  }>(
    await db.execute(sql`
      SELECT r.binding_id, r.kind, s.id AS session_id, d.name AS box,
             s.metadata ->> 'terminalName' AS terminal, COALESCE(s.started_at, s.created_at) AS since
        FROM support_rooms r
        JOIN agent_sessions s ON s.id = r.session_id
        LEFT JOIN devices d ON d.id = s.device_id
       WHERE r.project_id = ${projectId} AND r.rid = ${rid}
       ORDER BY r.created_at`),
  );
  for (const room of rooms) {
    if (!(await roomIsBound({ bindingId: room.binding_id, rid }))) continue;
    return {
      kind: 'channel',
      // a channel agent's rooms all read its one session, under the role a peer looks it up by
      role: room.kind === 'agent' ? CHANNEL_AGENT_ROLE : room.kind,
      channel: rid,
      answeredBy: 'forge',
      box: room.box,
      address: forgeSessionAddress(room.session_id),
      terminal: room.terminal,
      since: iso(room.since),
    };
  }
  return null;
}

/** The agent outside Forge answering the group, as it last declared itself. */
function declaredAgentOf(channel: ChannelRow | null): AgentRoleView | null {
  if (!channel?.agentRole || !channel.agentAddress || !channel.agentDeclaredAt) return null;
  return {
    kind: 'channel',
    role: channel.agentRole,
    channel: channel.rid,
    answeredBy: 'outside',
    box: channel.agentBox,
    address: channel.agentAddress,
    terminal: null,
    since: channel.agentDeclaredAt.toISOString(),
  };
}

/** The agent session answering a bound group now (BC-42): Forge's bot, else the declared outside one. */
export async function channelAgentOf(
  projectId: string,
  rid: string,
  channel?: ChannelRow | null,
): Promise<AgentRoleView | null> {
  const forge = await forgeBotOf(projectId, rid);
  if (forge) return forge;
  if (!(await answeredOutside(projectId, rid))) return null;
  return declaredAgentOf(channel === undefined ? await channelOf(projectId, rid) : channel);
}

/**
 * The project's agent sessions by role (BC-43): live masters, then the agent of each bound channel.
 * `role` narrows it to the sessions holding that role, read case-blind (BC-44).
 */
export async function agentRolesOf(
  viewer: string,
  projectId: string,
  role?: string,
): Promise<AgentRoleView[]> {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  const masters: AgentRoleView[] = (await liveMasterSessions(projectId)).map((m) => ({
    kind: 'master',
    role: 'master',
    channel: null,
    answeredBy: 'forge',
    box: m.box,
    address: forgeSessionAddress(m.sessionId),
    terminal: m.terminal,
    since: m.since,
  }));
  const channels: AgentRoleView[] = [];
  for (const rid of await boundRidsOf(projectId)) {
    const agent = await channelAgentOf(projectId, rid);
    if (agent) channels.push(agent);
  }
  const all = [...masters, ...channels];
  const wanted = role?.trim().toLowerCase();
  return wanted ? all.filter((a) => a.role.toLowerCase() === wanted) : all;
}

/**
 * An agent outside Forge declares itself on the group it answers (BC-42): its role, its box and the
 * address it is reached at now, written again on each restart. Only a group a binding of the project
 * names in `outsideRids` takes one: Forge's own bot is read off its session, never declared.
 */
export async function declareOutsideAgent(
  viewer: string,
  projectId: string,
  rid: string,
  write: ChannelAgentWrite,
): Promise<Outcome<AgentRoleView>> {
  await requireCan(actorFor(viewer), 'project.write', projectResource(projectId));
  for (const [field, text] of Object.entries(write)) {
    const refused = privateRefusal<AgentRoleView>(`/${field}`, text);
    if (refused) return refused;
  }
  if (!(await channelIsBound(projectId, rid))) {
    return no(
      'SUPPORT_CHANNEL_UNKNOWN',
      '/rid',
      `no binding of this project attaches the group ${rid}`,
    );
  }
  if (!(await answeredOutside(projectId, rid))) {
    return no(
      'SUPPORT_CHANNEL_NOT_OUTSIDE',
      '/rid',
      `no binding of this project names the group ${rid} in \`outsideRids\`, so Forge's own session answers it and is read off that session; an outside agent declares itself only on a group answered outside Forge`,
    );
  }
  const channel = await declareChannelAgent((await ensureChannel(projectId, rid)).id, {
    ...write,
    by: viewer,
  });
  const agent = declaredAgentOf(channel);
  if (!agent) throw new Error(`support: the agent declared on ${rid} did not read back`);
  return { ok: true, value: agent };
}
