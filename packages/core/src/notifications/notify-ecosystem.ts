import type { OutboxEventPayload as Payload } from '@forge/contracts/outbox-events';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { notifications, projectMembers, projects, users } from '../db/schema.js';
import { userLabel } from '../issues/index.js';
import { logger } from '../lib/logger.js';
import { consume } from '../outbox/index.js';
import { resolveNotifications } from './auto-resolve.js';
import { emitNotification } from './emit.js';
import { projectAdminUserIdsFor } from './project-admins.js';

type Notice = Parameters<typeof emitNotification>[0];

async function humans(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...new Set(ids)]), eq(users.kind, 'human')));
  return new Set(rows.map((r) => r.id));
}

// the people of a side are everyone holding a role on its project, explicit or derived from the org, and never its agents
async function peopleBySide(projectIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(projectIds)];
  const [members, admins] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
          .from(projectMembers)
          .where(inArray(projectMembers.projectId, ids)),
    projectAdminUserIdsFor(ids),
  ]);
  const all = new Map(ids.map((id) => [id, new Set(admins.get(id) ?? [])]));
  for (const m of members) all.get(m.projectId)?.add(m.userId);
  const human = await humans([...all.values()].flatMap((s) => [...s]));
  return new Map([...all].map(([id, s]) => [id, [...s].filter((u) => human.has(u))]));
}

async function slugsOf(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(inArray(projects.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.slug]));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// a person is named as the bell names them everywhere else, their display name or else their address; an id no account carries is said as it was given
async function nameOf(id: string | null): Promise<string> {
  if (!id) return 'someone';
  if (!UUID.test(id)) return id;
  return (await userLabel(id)) ?? id;
}

const NOTE_LINE_MAX = 160;

function firstLine(text: string | null): string | null {
  const line = text
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > NOTE_LINE_MAX ? `${line.slice(0, NOTE_LINE_MAX - 1)}…` : line;
}

const holdKey = (h: Payload<'channel.threadHeld'>, side: string) =>
  `channel-hold:${h.ecosystemId}:${h.thread}:${side}`;

const gateKey = (documentId: string) => `channel-gate:${documentId}`;

// a delivery is at least once, so a notice already recorded under its dedupe key is not raised twice by a redelivery
async function told(dedupeKey: string | null | undefined): Promise<boolean> {
  if (!dedupeKey) return false;
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(eq(notifications.dedupeKey, dedupeKey))
    .limit(1);
  return Boolean(row);
}

// each side reads the notice under its own project, and a person on both sides is told once
async function tellEachSide(
  sides: readonly string[],
  except: string | null,
  notice: (side: string, recipients: string[]) => Notice,
): Promise<void> {
  const people = await peopleBySide(sides);
  const heard = new Set(except ? [except] : []);
  for (const side of sides) {
    const recipients = (people.get(side) ?? []).filter((u) => !heard.has(u));
    for (const u of recipients) heard.add(u);
    if (recipients.length === 0) continue;
    const n = notice(side, recipients);
    if (!(await told(n.dedupeKey))) await emitNotification(n);
  }
}

async function published(p: Payload<'channel.documentPublished'>): Promise<void> {
  const slugs = await slugsOf([p.projectId, ...p.to]);
  const to = p.to.map((id) => slugs.get(id) ?? id).join(', ');
  await tellEachSide([p.projectId, ...p.to], p.authorPersonId, (side, recipients) => ({
    recipients,
    projectId: side,
    type: 'channel_document_published',
    title: `${p.number} published: ${p.subject}`,
    body: `A ${p.type} from ${slugs.get(p.projectId) ?? p.projectId} to ${to}.`,
    dedupeKey: `channel-published:${p.documentId}:${side}`,
  }));
}

async function held(h: Payload<'channel.threadHeld'>): Promise<void> {
  if (h.action === 'release') {
    const why = firstLine(h.reason);
    const outcome = `${h.thread} released by ${await nameOf(h.byId)}${why ? `: ${why}` : ', with no reason given'}`;
    for (const side of h.parties) await resolveNotifications(holdKey(h, side), outcome);
    return;
  }
  const slugs = await slugsOf([h.projectId]);
  await tellEachSide(h.parties, h.byId, (side, recipients) => ({
    recipients,
    projectId: side,
    type: 'channel_thread_held',
    title: `${h.thread} is held: no agent adds to it until a person releases it`,
    body: `Held for ${slugs.get(h.projectId) ?? h.projectId}: ${h.reason ?? ''}`,
    resolutionKey: holdKey(h, side),
  }));
}

async function gateAsked(p: Payload<'channel.gateAsked'>): Promise<void> {
  const admins = (await projectAdminUserIdsFor([p.projectId])).get(p.projectId) ?? [];
  const human = await humans(admins);
  const recipients = admins.filter((u) => human.has(u));
  if (recipients.length === 0) {
    logger.error(
      { documentId: p.documentId, number: p.number, project: p.projectId },
      'channel: a document waits at its approve gate and its project has no admin to approve it',
    );
    return;
  }
  await emitNotification({
    recipients,
    projectId: p.projectId,
    type: 'channel_gate_pending',
    title: `${p.number} waits for your approval: ${p.subject}`,
    body: `A ${p.type} this project wrote is held at the approve gate until an admin approves or returns it.`,
    resolutionKey: gateKey(p.documentId),
  });
}

// a decided gate is told by what decided it — approved and the number it went out as, or returned and what to change — because the pending title it resolves still says it waits
async function gateDecided(p: Payload<'channel.gateDecided'>): Promise<void> {
  const who = await nameOf(p.decidedBy);
  const number = p.number ?? 'the document';
  const note = firstLine(p.note);
  const outcome = p.published
    ? `${number} approved by ${who} and published as ${number}: ${p.subject}`
    : `${number} returned by ${who}${note ? `: ${note}` : ''}`;
  await resolveNotifications(gateKey(p.documentId), outcome);
}

/**
 * What the bell tells a consumer of an approved version that is not breaking: an additive one is
 * adopted in one act (feedback-triage `breaking`), which moves the interface and the links and names
 * the requirements a person re-pins; any other owes this project nothing.
 */
export function versionNoticeBody(p: Payload<'contract.versionApproved'>, side: string): string {
  const ref = `${p.providerSlug}/${p.contractSlug}`;
  const measured = `${p.providerSlug} approved ${p.version} of ${ref}, measured ${p.classification}`;
  if (p.classification !== 'non-breaking') return `${measured}; nothing this project does is owed.`;
  return `${measured}. Adopt it in one act, POST /api/projects/${side}/interface/adopt { contract: "${ref}", version: "${p.version}" }: it moves the interface and every link to ${p.version} where each field a link uses is still in it, and names each requirement left for a person to re-pin.`;
}

// a breaking approval files each consumer an item instead, so only a version that is not breaking is told as a notice
async function versionApproved(p: Payload<'contract.versionApproved'>): Promise<void> {
  if (p.classification === 'breaking') return;
  const ref = `${p.providerSlug}/${p.contractSlug}`;
  await tellEachSide(
    p.consumerIds,
    p.filer.agency === 'human' ? p.filer.userId : null,
    (side, recipients) => ({
      recipients,
      projectId: side,
      type: 'contract_version_published',
      title: `${ref} ${p.version} is published`,
      body: versionNoticeBody(p, side),
      dedupeKey: `contract-published:${p.projectId}/${p.contractSlug}@${p.version}:${side}`,
    }),
  );
}

/** The bell for every ecosystem act another side or an admin is told of. */
export function registerEcosystemNotifications(): void {
  const name = 'notify-ecosystem';
  consume('channel.documentPublished', { name, handle: published });
  consume('channel.threadHeld', { name, handle: held });
  consume('channel.gateAsked', { name, handle: gateAsked });
  consume('channel.gateDecided', { name, handle: gateDecided });
  consume('contract.versionApproved', { name, handle: versionApproved });
}
