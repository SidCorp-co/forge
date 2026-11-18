// A membership act named the way a person says it in chat (ISS-1299): "link ePOD into the forge
// ecosystem" names an ecosystem by its slug and a project, never a membership id. The steward's
// invite and the member's accept, decline and leave go through the same services their routes call
// (`membership-service.ts:invite`, `transition`), as the person, so their own grants decide: org.admin
// on the steward organization for an invite, project.admin on the member project for the rest. Every
// refusal, a 403 included, comes back by its own name, with nothing done.

import { eq, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { ecosystems } from '../db/schema-ecosystem.js';
import { isRefusal } from '../lib/refusal.js';
import type { MembershipRow } from './membership-rules.js';
import { invite, transition } from './membership-service.js';
import { openMembership } from './membership-store.js';

/** The membership acts a person's word in chat makes. */
export const MEMBERSHIP_ACTS = ['invite', 'accept', 'decline', 'leave'] as const;
export type MembershipAct = (typeof MEMBERSHIP_ACTS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The membership the act left, or why nothing was done, each refusal by its own code. */
export type MembershipActOutcome =
  | { ok: true; membership: MembershipRow }
  | { ok: false; refusals: { code: string; path: string; detail: string }[] };

const refused = (code: string, path: string, detail: string): MembershipActOutcome => ({
  ok: false,
  refusals: [{ code, path, detail }],
});

/** The ecosystem `named` names, by its slug or its id, or null. */
async function ecosystemNamed(named: string): Promise<{ id: string; slug: string } | null> {
  const key = named.trim();
  const [row] = await db
    .select({ id: ecosystems.id, slug: ecosystems.slug })
    .from(ecosystems)
    .where(
      UUID.test(key)
        ? or(eq(ecosystems.id, key), eq(ecosystems.slug, key))
        : eq(ecosystems.slug, key.toLowerCase()),
    )
    .limit(1);
  return row ?? null;
}

async function made(input: {
  act: MembershipAct;
  ecosystem: string;
  projectId: string;
  projectSlug: string;
  userId: string;
  reason: string | null;
}): Promise<MembershipActOutcome> {
  const eco = await ecosystemNamed(input.ecosystem);
  if (!eco) {
    return refused(
      'REF_UNRESOLVED',
      '/item',
      `no ecosystem has the slug or id ${input.ecosystem}; name the ecosystem as its page does. Nothing was done.`,
    );
  }
  if (input.act === 'invite') {
    return invite({ ecosystemId: eco.id, projectId: input.projectId, userId: input.userId });
  }
  if (input.act === 'leave' && !input.reason) {
    return refused(
      'MEMBERSHIP_REASON_REQUIRED',
      '/reason',
      `leaving ${eco.slug} says why: pass his why as reason. Nothing was done.`,
    );
  }
  const open = await openMembership(db, eco.id, input.projectId);
  if (!open) {
    return refused(
      'MEMBERSHIP_NONE',
      '/item',
      `${input.projectSlug} holds no open membership in ${eco.slug}: it is ${input.act === 'leave' ? 'no member' : 'not invited'}. ${input.act === 'leave' ? 'Nothing to leave' : `The steward invites it first (ecosystem.invite), then ${input.act} answers the invitation`}. Nothing was done.`,
    );
  }
  return transition({
    membershipId: open.id,
    verb: input.act,
    userId: input.userId,
    reason: input.act === 'leave' ? input.reason : null,
  });
}

/**
 * Make `act` on `projectId`'s membership of the ecosystem `ecosystem` names, as `userId`: the invite
 * for the steward, the answer or the leave for the member. Refused by name, nothing done, where his
 * grants or the membership's state say no.
 */
export async function membershipActByName(input: {
  act: MembershipAct;
  ecosystem: string;
  projectId: string;
  projectSlug: string;
  userId: string;
  reason: string | null;
}): Promise<MembershipActOutcome> {
  try {
    return await made(input);
  } catch (err) {
    if (isRefusal(err)) return { ok: false, refusals: [...err.refusals] };
    if (err instanceof HTTPException && (err.status === 403 || err.status === 404)) {
      const code = (err.cause as { code?: string } | undefined)?.code ?? 'FORBIDDEN';
      return refused(code, '/act', `${err.message}. Nothing was done.`);
    }
    throw err;
  }
}
