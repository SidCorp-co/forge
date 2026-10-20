/**
 * Who may revoke a device (ISS-1229 r23): the account that paired it, or whoever holds the admin
 * role in an organization the agent account holding it belongs to. An agent has no session of its
 * own and a project-fenced token, so a device it paired is its organization's to manage; the rule is
 * the role, never a kind of person, so an agent account holding that role passes it too.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db/client.js';
import { organizationMembers, users } from '../db/schema.js';

const ORG_DEVICE_MANAGERS = ['owner', 'admin'] as const;

export async function mayRevokeDevice(ownerId: string, callerId: string): Promise<boolean> {
  if (ownerId === callerId) return true;
  const agentIn = alias(organizationMembers, 'agent_in');
  const callerIn = alias(organizationMembers, 'caller_in');
  const [held] = await db
    .select({ orgId: agentIn.orgId })
    .from(users)
    .innerJoin(agentIn, eq(agentIn.userId, users.id))
    .innerJoin(
      callerIn,
      and(
        eq(callerIn.orgId, agentIn.orgId),
        eq(callerIn.userId, callerId),
        inArray(callerIn.role, [...ORG_DEVICE_MANAGERS]),
      ),
    )
    .where(and(eq(users.id, ownerId), eq(users.kind, 'agent')))
    .limit(1);
  return held !== undefined;
}

export const REVOKE_REFUSAL =
  'Only the account that paired this device, or an admin of an organization whose agent paired it, can revoke it.';
