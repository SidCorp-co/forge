// A bound channel's page under Product (REQ-75 r6 BC-30): its record for a project reader, and what
// a person writes there — a member's roles and what to ask them for, written confirmed (BC-33), and
// rules added or removed by hand. The session writes through `/support/session/*` instead.

import { chatUsernameSchema } from '@forge/contracts/support';
import {
  type ChannelMemberWrite,
  channelAgentWriteSchema,
  channelMemberWriteSchema,
  channelRuleWriteSchema,
} from '@forge/contracts/support-channel';
import type { Hono } from 'hono';
import { z } from 'zod';
import { refused } from '../lib/refusal.js';
import type { AuthVars } from '../middleware/auth.js';
import { invalid, strictBody, zValidator } from '../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { agentRolesOf, declareOutsideAgent } from './agent-roles.js';
import { privateRefusal } from './channel.js';
import { channelsOf, channelViewOf } from './channel-read.js';
import {
  addRule,
  channelIsBound,
  ensureChannel,
  removeRule,
  writeMember,
} from './channel-store.js';
import { no, type Outcome } from './outcome.js';

const rid = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'a Rocket.Chat room id');
const channelParam = zValidator(
  'param',
  z.object({ id: z.uuid(), rid }),
  invalid('invalid path: a project uuid and a Rocket.Chat room id'),
);
const memberParam = zValidator(
  'param',
  z.object({ id: z.uuid(), rid, username: chatUsernameSchema }),
  invalid('invalid path: a project uuid, a Rocket.Chat room id and a username'),
);
const ruleParam = zValidator(
  'param',
  z.object({ id: z.uuid(), rid, ruleId: z.uuid() }),
  invalid('invalid path: a project uuid, a Rocket.Chat room id and a rule uuid'),
);
const projectParam = zValidator(
  'param',
  z.object({ id: z.uuid() }),
  invalid('invalid path: the project id is a uuid'),
);

const unknownChannel = <T>(rid: string): Outcome<T> =>
  no('SUPPORT_CHANNEL_UNKNOWN', '/rid', `no binding of this project attaches the group ${rid}`);

/** The channel a person writes to: one a binding of the project attaches, whoever answers it. */
async function writableChannel(viewer: string, projectId: string, rid: string) {
  await requireCan(actorFor(viewer), 'project.write', projectResource(projectId));
  if (!(await channelIsBound(projectId, rid))) return null;
  return ensureChannel(projectId, rid);
}

/** A person's correction of a member: written confirmed, whatever the bot inferred (BC-33). */
export async function confirmMember(
  viewer: string,
  projectId: string,
  rid: string,
  username: string,
  write: ChannelMemberWrite,
): Promise<Outcome<{ username: string }>> {
  const refusedPrivate = privateRefusal<{ username: string }>('/askFor', write.askFor);
  if (refusedPrivate) return refusedPrivate;
  const channel = await writableChannel(viewer, projectId, rid);
  if (!channel) return unknownChannel(rid);
  const row = await writeMember({
    channelId: channel.id,
    username,
    roles: write.roles,
    askFor: write.askFor,
    state: 'confirmed',
    confirmedBy: viewer,
    sourceMessage: null,
  });
  if (!row) throw new Error(`support: confirming member ${username} wrote no row`);
  return { ok: true, value: { username: row.username } };
}

const rolesQuery = zValidator(
  'query',
  z.object({ role: z.string().trim().min(1).max(80).optional() }),
  invalid('invalid query: role is a role name, at most 80 characters'),
);

export function mountChannelRoutes(routes: Hono<{ Variables: AuthVars }>): void {
  // the project's agent sessions by role, each with where it is reached now (REQ-75 r7 BC-43, BC-44)
  routes.get('/:id/agent-roles', projectParam, rolesQuery, async (c) => {
    const { id } = c.req.valid('param');
    const sessions = await agentRolesOf(c.get('userId'), id, c.req.valid('query').role);
    return c.json({ sessions });
  });

  // an agent outside Forge declares itself on the group it answers, again on each restart (BC-42)
  routes.put(
    '/:id/support/channels/:rid/agent',
    channelParam,
    strictBody(channelAgentWriteSchema, '{ role, box, address }'),
    async (c) => {
      const { id, rid } = c.req.valid('param');
      const out = await declareOutsideAgent(c.get('userId'), id, rid, c.req.valid('json'));
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      return c.json({ agent: out.value });
    },
  );

  routes.get('/:id/support/channels', projectParam, async (c) => {
    const channels = await channelsOf(c.get('userId'), c.req.valid('param').id);
    return c.json({ channels });
  });

  routes.get('/:id/support/channels/:rid', channelParam, async (c) => {
    const { id, rid } = c.req.valid('param');
    const channel = await channelViewOf(c.get('userId'), id, rid);
    if (!channel) {
      const out = unknownChannel(rid);
      return refused(c, out.ok ? [] : out.refusals, 'SUPPORT_REFUSED');
    }
    return c.json({ channel });
  });

  routes.put(
    '/:id/support/channels/:rid/members/:username',
    memberParam,
    strictBody(
      channelMemberWriteSchema,
      '{ roles: (user | product | technical | maintenance | bot)[], askFor?: string | null }',
    ),
    async (c) => {
      const { id, rid, username } = c.req.valid('param');
      const out = await confirmMember(c.get('userId'), id, rid, username, c.req.valid('json'));
      if (!out.ok) return refused(c, out.refusals, 'SUPPORT_REFUSED');
      const channel = await channelViewOf(c.get('userId'), id, rid);
      return c.json({ member: channel?.memberRows.find((m) => m.username === out.value.username) });
    },
  );

  routes.post(
    '/:id/support/channels/:rid/rules',
    channelParam,
    strictBody(channelRuleWriteSchema, '{ text }'),
    async (c) => {
      const { id, rid } = c.req.valid('param');
      const { text } = c.req.valid('json');
      const refusedPrivate = privateRefusal('/text', text);
      if (refusedPrivate && !refusedPrivate.ok) {
        return refused(c, refusedPrivate.refusals, 'SUPPORT_REFUSED');
      }
      const channel = await writableChannel(c.get('userId'), id, rid);
      if (!channel) {
        const out = unknownChannel(rid);
        return refused(c, out.ok ? [] : out.refusals, 'SUPPORT_REFUSED');
      }
      const rule = await addRule({ channelId: channel.id, text, addedBy: c.get('userId') });
      return c.json({ rule: { id: rule.id, text: rule.text } }, 201);
    },
  );

  routes.delete('/:id/support/channels/:rid/rules/:ruleId', ruleParam, async (c) => {
    const { id, rid, ruleId } = c.req.valid('param');
    const channel = await writableChannel(c.get('userId'), id, rid);
    if (!channel || !(await removeRule(channel.id, ruleId))) {
      return refused(
        c,
        [
          {
            code: 'SUPPORT_RULE_UNKNOWN',
            path: '/ruleId',
            detail: `this channel holds no rule ${ruleId}`,
          },
        ],
        'SUPPORT_REFUSED',
      );
    }
    return c.body(null, 204);
  });
}
