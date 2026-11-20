// A credential a person hands over in a bound room, kept (ISS-1372, owner 2026-11-20: "from chat
// down it has to be kept"). The room's screen caught it; core stores the value in the bound project's
// vault, `secret://kept/<name>`, before the message is recorded redacted, so Forge holds the one copy
// it needs and no transcript, prompt, log or room record holds any. It is the same store and the same
// audit as every other project secret: the value is a `project_secrets` row, and what the entry is
// (who sent it, where, its proposed name and kind, whether it waits for an admin) is the write's own
// row of the credential audit (`project_variable_events.detail.kept`), never the value.
//
// Trust is by grant: a sender holding project admin makes it usable at once; anyone else's waits for
// a project admin to approve it, and is discarded unused after `SUPPORT_KEPT_PENDING_HOURS`. A usable
// entry is read by the project's master and its runs at the acting door (`acting-secret-door.ts`),
// each read audited there.

import { secretRefOf } from '@forge/contracts/project-config';
import { SUPPORT_KEPT_PENDING_HOURS, SUPPORT_KEPT_SECRET_SCOPE } from '@forge/contracts/support';
import { and, asc, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectVariableEvents } from '../db/schema-project-variables.js';
import { encryptSecret, fingerprintSecret, isVaultConfigured } from '../integrations/index.js';
import { drizzleConfigStore } from './store.js';
import { insertEvents } from './variables-store.js';

export const KEPT_STATES = ['usable', 'pending', 'expired', 'discarded'] as const;
export type KeptState = (typeof KEPT_STATES)[number];

/** Who handed the credential over: their chat account, and their Forge account where linked. */
export interface KeptSender {
  chatKey: string;
  label: string | null;
  userId: string | null;
  /** Whether they held project admin on the bound project when they sent it. */
  admin: boolean;
}

/** What the audit row keeps of an entry: everything but the value. */
export interface KeptRecord {
  name: string;
  /** The proposed name in words, as the room said it ("AdminHub production token"). */
  label: string;
  kind: string;
  from: KeptSender;
  room: string;
  thread: string;
  message: string;
  at: string;
  /** Null where a project admin sent it, usable at once. */
  expiresAt: string | null;
  /** Acts done with it are recorded as this person (a personal session token is theirs). */
  actsAs: string;
}

export interface KeptEntry extends KeptRecord {
  ref: string;
  state: KeptState;
  fingerprint: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
}

const refOf = (name: string) => secretRefOf(SUPPORT_KEPT_SECRET_SCOPE, name);

/**
 * The value kept under `name`, with its record, in one transaction; null where this core has no
 * vault key, so nothing can be encrypted and the caller says it was not kept. A name already held
 * (the same chat message delivered twice) is kept as it was.
 */
export async function keepChatSecret(input: {
  projectId: string;
  value: string;
  record: Omit<KeptRecord, 'expiresAt'>;
}): Promise<KeptEntry | null> {
  if (!isVaultConfigured()) return null;
  const held = await keptEntry(input.projectId, input.record.name);
  if (held) return held;
  const { projectId, record } = input;
  const expiresAt = record.from.admin
    ? null
    : new Date(Date.parse(record.at) + SUPPORT_KEPT_PENDING_HOURS * 3_600_000).toISOString();
  const kept: KeptRecord = { ...record, expiresAt };
  const fingerprint = fingerprintSecret(projectId, input.value);
  await db.transaction(async (tx) => {
    await drizzleConfigStore.putSecret(tx, {
      projectId,
      scope: SUPPORT_KEPT_SECRET_SCOPE,
      name: record.name,
      valueEnc: encryptSecret(input.value),
    });
    await insertEvents(tx, [
      {
        projectId,
        variableId: null,
        act: 'created',
        key: refOf(record.name),
        environment: null,
        actorId: record.from.userId,
        actorTokenId: null,
        agency: 'human',
        newFingerprint: fingerprint,
        detail: { secret: true, via: 'room', kept },
      },
    ]);
  });
  return {
    ...kept,
    ref: refOf(record.name),
    state: kept.expiresAt ? 'pending' : 'usable',
    fingerprint,
    decidedBy: null,
    decidedAt: null,
  };
}

type EventRow = {
  key: string;
  act: string;
  actorId: string | null;
  newFingerprint: string | null;
  detail: Record<string, unknown>;
  at: Date;
};

/** An entry as its audit rows tell it, oldest first: the keep, then any approval, discard or replace. */
function entryOf(rows: readonly EventRow[], now: Date): KeptEntry | null {
  const [first, ...later] = rows;
  const kept = first?.detail.kept as KeptRecord | undefined;
  if (first?.act !== 'created' || !kept) return null;
  let state: KeptState = kept.expiresAt ? 'pending' : 'usable';
  let decidedBy: string | null = null;
  let decidedAt: string | null = null;
  let fingerprint = first.newFingerprint;
  for (const r of later) {
    if (r.act === 'deleted' || r.act === 'rejected') {
      state = r.detail.expired === true ? 'expired' : 'discarded';
    } else if (r.act === 'approved' || r.act === 'updated') {
      // an approval, or a project admin's replacement through the secret's own door, is an admin's word
      state = 'usable';
      fingerprint = r.newFingerprint ?? fingerprint;
    } else continue;
    decidedBy = r.actorId;
    decidedAt = r.at.toISOString();
  }
  if (state === 'pending' && kept.expiresAt && Date.parse(kept.expiresAt) <= now.getTime()) {
    state = 'expired';
  }
  return { ...kept, ref: refOf(kept.name), state, fingerprint, decidedBy, decidedAt };
}

async function eventsOf(projectId: string, refs?: readonly string[]): Promise<EventRow[]> {
  return db
    .select({
      key: projectVariableEvents.key,
      act: projectVariableEvents.act,
      actorId: projectVariableEvents.actorId,
      newFingerprint: projectVariableEvents.newFingerprint,
      detail: projectVariableEvents.detail,
      at: projectVariableEvents.at,
    })
    .from(projectVariableEvents)
    .where(
      and(
        eq(projectVariableEvents.projectId, projectId),
        refs
          ? inArray(projectVariableEvents.key, [...refs])
          : like(projectVariableEvents.key, `${refOf('')}%`),
      ),
    )
    .orderBy(asc(projectVariableEvents.at), asc(projectVariableEvents.id));
}

function entriesOf(rows: readonly EventRow[]): KeptEntry[] {
  const byRef = new Map<string, EventRow[]>();
  for (const r of rows) byRef.set(r.key, [...(byRef.get(r.key) ?? []), r]);
  const now = new Date();
  return [...byRef.values()].flatMap((r) => entryOf(r, now) ?? []);
}

/**
 * A pending entry past its expiry has its value destroyed, with the audit row saying so: it was
 * never approved, so nothing may read it. Done where an entry is read, so no value outlives its day.
 */
async function destroyExpired(projectId: string, entries: KeptEntry[]): Promise<void> {
  for (const e of entries.filter((x) => x.state === 'expired')) {
    await db.transaction(async (tx) => {
      if (
        !(await drizzleConfigStore.deleteSecret(tx, projectId, SUPPORT_KEPT_SECRET_SCOPE, e.name))
      ) {
        return;
      }
      await insertEvents(tx, [
        {
          projectId,
          variableId: null,
          act: 'deleted',
          key: e.ref,
          environment: null,
          actorId: null,
          actorTokenId: null,
          agency: null,
          detail: { secret: true, by: 'core', expired: true, kept: { name: e.name } },
        },
      ]);
    });
  }
}

/** Every credential kept from the project's rooms, newest first; an expired one's value destroyed. */
export async function keptEntries(projectId: string): Promise<KeptEntry[]> {
  const entries = entriesOf(await eventsOf(projectId));
  await destroyExpired(projectId, entries);
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/** One kept entry by name; null where the project kept none by it. */
export async function keptEntry(projectId: string, name: string): Promise<KeptEntry | null> {
  const [entry] = entriesOf(await eventsOf(projectId, [refOf(name)]));
  if (!entry) return null;
  await destroyExpired(projectId, [entry]);
  return entry;
}

export type KeptDecision =
  | { ok: true; entry: KeptEntry }
  | { ok: false; code: 'KEPT_SECRET_UNKNOWN' | 'KEPT_SECRET_NOT_PENDING'; detail: string };

/**
 * A project admin's word on a pending entry: `approve` makes it usable by the master and its runs,
 * `discard` destroys the value. An entry already decided, expired or usable is refused by name.
 */
export async function decideKept(input: {
  projectId: string;
  name: string;
  decision: 'approve' | 'discard';
  actor: { id: string; tokenId: string | null };
}): Promise<KeptDecision> {
  const entry = await keptEntry(input.projectId, input.name);
  if (!entry) {
    return {
      ok: false,
      code: 'KEPT_SECRET_UNKNOWN',
      detail: `this project kept no credential from a room under ${refOf(input.name)}; GET /api/projects/${input.projectId}/kept-secrets lists the ones it kept. Nothing was changed.`,
    };
  }
  const discardable =
    entry.state === 'pending' || (input.decision === 'discard' && entry.state === 'usable');
  if (!discardable) {
    return {
      ok: false,
      code: 'KEPT_SECRET_NOT_PENDING',
      detail: `${entry.ref} is ${entry.state}${entry.decidedAt ? ` since ${entry.decidedAt}` : ''}, so there is nothing to ${input.decision}; ${entry.state === 'expired' ? 'its value was destroyed unapproved, and the person sends it again to keep it' : 'only a pending entry is approved'}. Nothing was changed.`,
    };
  }
  await db.transaction(async (tx) => {
    if (input.decision === 'discard') {
      await drizzleConfigStore.deleteSecret(
        tx,
        input.projectId,
        SUPPORT_KEPT_SECRET_SCOPE,
        entry.name,
      );
    }
    await insertEvents(tx, [
      {
        projectId: input.projectId,
        variableId: null,
        act: input.decision === 'approve' ? 'approved' : 'rejected',
        key: entry.ref,
        environment: null,
        actorId: input.actor.id,
        actorTokenId: input.actor.tokenId,
        agency: 'human',
        detail: { secret: true, kept: { name: entry.name, decision: input.decision } },
      },
    ]);
  });
  const after = await keptEntry(input.projectId, input.name);
  return { ok: true, entry: after ?? entry };
}
