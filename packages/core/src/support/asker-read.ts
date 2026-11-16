// `asker`: who wrote a message, and what their thread holds around it (ISS-1250, owner 2026-11-16).
// The shared operations room's record held no member, so its agent answered the organization's owner
// knowing nothing of him and sent him to a settings page; nothing in reach told it who he was. This
// door is the agent's to call before it reads a ruling or chooses its tone, and it writes nothing: the
// writer's Forge account (a confirmed link, or the address the chat server verified, as an operations
// write names its asker, `ops-asker.ts`) with their organization role, their roles on its projects
// and the projects they filed in lately; the member row the channel record holds; the roles their
// account says, which the agent may keep with `member`; and the thread around the message.

import type { ChannelRole } from '@forge/contracts/support-channel';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { readerOf } from './channel.js';
import { channelOf, memberMessage, memberOf } from './channel-store.js';
import { forgeUserOfWriter } from './ops-asker.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import type { RoomRow } from './store.js';
import { aroundMessage, openAsksOf, type ThreadAround, threadLines } from './thread-context.js';

/** How many projects a writer filed in lately are named. */
const WORKED_SHOWN = 3;

/** How a reply to this writer reads: the owner's, a team member's, or a user's. */
export type AskerReader = 'owner' | 'detail' | 'plain';

export interface AskerFacts {
  /** Their Forge account: its name, or null where Forge cannot name the writer (and why). */
  forge: { account: string | null } | { account: null; unnamed: string };
  /** Their role in the organization the room's project belongs to. */
  org: 'owner' | 'admin' | 'member' | null;
  /** Their roles on that organization's projects: `slug role`. */
  projects: string[];
  /** The projects they filed issues in over the last 30 days, most first. */
  worked: string[];
  /** The channel record's row for them: its roles and whether a person confirmed it; null where none. */
  member: { roles: string[]; confirmed: boolean } | null;
  /** The roles their account says, for `member` where the record holds none or holds others. */
  accountRoles: ChannelRole[];
  reader: AskerReader;
  thread: ThreadAround & { openAsks: string[] };
}

type OrgRole = AskerFacts['org'];

async function accountOf(userId: string, projectId: string) {
  const [org] = (await db.execute(sql`
    SELECT m.role FROM organization_members m JOIN projects p ON p.org_id = m.org_id
     WHERE p.id = ${projectId}::uuid AND m.user_id = ${userId}::uuid
  `)) as unknown as { role: OrgRole }[];
  const projects = (await db.execute(sql`
    SELECT p.slug, pm.role FROM project_members pm
      JOIN projects p ON p.id = pm.project_id
      JOIN projects home ON home.org_id = p.org_id
     WHERE home.id = ${projectId}::uuid AND pm.user_id = ${userId}::uuid
     ORDER BY p.slug
  `)) as unknown as { slug: string; role: string }[];
  const worked = (await db.execute(sql`
    SELECT p.slug FROM issues i JOIN projects p ON p.id = i.project_id
     WHERE i.created_by_id = ${userId}::uuid AND i.created_at > now() - interval '30 days'
     GROUP BY p.slug ORDER BY count(*) DESC, p.slug LIMIT ${WORKED_SHOWN}
  `)) as unknown as { slug: string }[];
  const [user] = (await db.execute(sql`
    SELECT display_name AS name FROM users WHERE id = ${userId}::uuid
  `)) as unknown as { name: string | null }[];
  return { org: org?.role ?? null, projects, worked: worked.map((w) => w.slug), name: user?.name };
}

/**
 * The channel roles a Forge account says (BC-30): an organization's owner or admin, or a project's
 * admin, decides and builds (product, technical); a project member builds (technical); anyone else
 * reads as a user.
 */
export function rolesOfAccount(org: OrgRole, projects: readonly { role: string }[]): ChannelRole[] {
  if (org === 'owner' || org === 'admin') return ['product', 'technical'];
  if (projects.some((p) => p.role === 'admin')) return ['product', 'technical'];
  if (projects.some((p) => p.role === 'member')) return ['technical'];
  return ['user'];
}

/** How a reply to them reads: the organization's owner first, else the record's, else the account's. */
export function readerFor(
  org: OrgRole,
  member: { roles: string[] } | null,
  accountRoles: readonly ChannelRole[],
): AskerReader {
  if (org === 'owner') return 'owner';
  return (
    readerOf((member ?? { roles: [...accountRoles] }) as Parameters<typeof readerOf>[0]) ?? 'plain'
  );
}

/** Who wrote `message` in `thread`, and the thread around it. Nothing is written or posted. */
export async function askerFacts(
  room: RoomRow,
  input: { thread: string; message: string },
): Promise<Outcome<AskerFacts>> {
  const conversationId = await knownThread(room, input.thread);
  if (!conversationId) return threadUnknown(input.thread);
  const said = await memberMessage(room.id, input.message);
  if (!said || said.thread !== input.thread) {
    return no(
      'OPS_ASKER_MESSAGE_UNKNOWN',
      '/message',
      `${input.message} is no member's message in thread ${input.thread}; name one as it carries \`message\` in what you were handed`,
    );
  }
  const named = await forgeUserOfWriter(room, { key: said.authorKey, label: said.author });
  const account = named.ok ? await accountOf(named.value.userId, room.projectId) : null;
  const channel = await channelOf(room.projectId, room.rid);
  const row = channel ? await memberOf(channel.id, said.author ?? said.authorKey) : null;
  const member = row ? { roles: row.roles, confirmed: row.state === 'confirmed' } : null;
  const org = account?.org ?? null;
  const accountRoles = rolesOfAccount(org, account?.projects ?? []);
  const [lines, openAsks] = await Promise.all([
    threadLines(conversationId),
    openAsksOf(room.id, input.thread),
  ]);
  return {
    ok: true,
    value: {
      forge: named.ok
        ? { account: account?.name ?? null }
        : { account: null, unnamed: named.refusals[0]?.detail ?? 'Forge cannot name them' },
      org,
      projects: (account?.projects ?? []).map((p) => `${p.slug} ${p.role}`),
      worked: account?.worked ?? [],
      member,
      accountRoles,
      reader: readerFor(org, member, accountRoles),
      thread: { ...aroundMessage(lines, input.message, said.authorKey), openAsks },
    },
  };
}
