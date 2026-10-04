import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectMembers, projects, users } from '../db/schema.js';
import { userLabel } from '../issues/actor-resolution.js';
import { logger } from '../observability/logger.js';
import type { ChannelDocument, ThreadHold } from './channel-schema.js';
import { ecosystemSignals } from './ports.js';

async function humans(ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...new Set(ids)]), eq(users.kind, 'human')));
  return new Set(rows.map((r) => r.id));
}

// cm:why the people of a side are everyone holding a role on its project, explicit or derived from the org, and never its agents
async function peopleBySide(projectIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(projectIds)];
  const [members, admins] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : db
          .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
          .from(projectMembers)
          .where(inArray(projectMembers.projectId, ids)),
    ecosystemSignals().projectAdmins(ids),
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

// cm:why a person is named as the bell names them everywhere else, their display name or else their address; an id no account carries is said as it was given
async function nameOf(id: string | undefined): Promise<string> {
  if (!id) return 'someone';
  if (!UUID.test(id)) return id;
  return (await userLabel(id)) ?? id;
}

const NOTE_LINE_MAX = 160;

function firstLine(text: string | undefined): string | null {
  const line = text
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > NOTE_LINE_MAX ? `${line.slice(0, NOTE_LINE_MAX - 1)}…` : line;
}

async function releasedOutcome(h: ThreadHold): Promise<string> {
  const why = firstLine(h.reason);
  return `${h.thread} released by ${await nameOf(h.by.id)}${why ? `: ${why}` : ', with no reason given'}`;
}

// cm:why a decided gate is told by what decided it — approved and the number it went out as, or returned and what to change — because the pending title it resolves still says it waits
async function gateOutcome(d: ChannelDocument): Promise<string> {
  const who = await nameOf(d.gate?.decidedBy);
  const number = d.number ?? 'the document';
  if (d.state === 'published') {
    return `${number} approved by ${who} and published as ${number}: ${d.subject}`;
  }
  const note = firstLine(d.gate?.note);
  return `${number} returned by ${who}${note ? `: ${note}` : ''}`;
}

async function signal(what: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (err) {
    logger.error({ err, what }, 'channel: a notification or wake failed after the write committed');
  }
}

const holdKey = (h: ThreadHold, side: string) => `channel-hold:${h.ecosystem}:${h.thread}:${side}`;

export const gateKey = (documentId: string) => `channel-gate:${documentId}`;

// cm:why each side reads the notice under its own project, and a person on both sides is told once
export async function tellEachSide(
  sides: readonly string[],
  except: string | null,
  emit: (side: string, recipients: string[]) => Promise<unknown>,
): Promise<void> {
  const people = await peopleBySide(sides);
  const told = new Set(except ? [except] : []);
  for (const side of sides) {
    const recipients = (people.get(side) ?? []).filter((u) => !told.has(u));
    for (const u of recipients) told.add(u);
    if (recipients.length > 0) await emit(side, recipients);
  }
}

export async function announcePublished(documentId: string, d: ChannelDocument): Promise<void> {
  await signal('channel_document_published', async () => {
    const slugs = await slugsOf([d.from, ...d.to]);
    const to = d.to.map((p) => slugs.get(p) ?? p).join(', ');
    await tellEachSide(
      [d.from, ...d.to],
      d.authoredBy.kind === 'person' ? d.authoredBy.id : null,
      (side, recipients) =>
        ecosystemSignals().notify({
          recipients,
          projectId: side,
          type: 'channel_document_published',
          title: `${d.number} published: ${d.subject}`,
          body: `A ${d.type} from ${slugs.get(d.from) ?? d.from} to ${to}.`,
          dedupeKey: `channel-published:${documentId}:${side}`,
        }),
    );
  });
  for (const side of d.to)
    await signal('master.wake', () => ecosystemSignals().wakeForChannel(side));
}

export async function announceHold(h: ThreadHold, parties: readonly string[]): Promise<void> {
  await signal('channel_thread_held', async () => {
    if (h.action === 'release') {
      const outcome = await releasedOutcome(h);
      for (const side of parties) await ecosystemSignals().resolve(holdKey(h, side), outcome);
      return;
    }
    const slugs = await slugsOf([h.side]);
    await tellEachSide(parties, h.by.id, (side, recipients) =>
      ecosystemSignals().notify({
        recipients,
        projectId: side,
        type: 'channel_thread_held',
        title: `${h.thread} is held: no agent adds to it until a person releases it`,
        body: `Held for ${slugs.get(h.side) ?? h.side}: ${h.reason ?? ''}`,
        resolutionKey: holdKey(h, side),
      }),
    );
  });
  for (const side of parties)
    await signal('master.wake', () => ecosystemSignals().wakeForChannel(side));
}

export async function announceGatePending(documentId: string, d: ChannelDocument): Promise<void> {
  await signal('channel_gate_pending', async () => {
    const admins = (await ecosystemSignals().projectAdmins([d.from])).get(d.from) ?? [];
    const human = await humans(admins);
    const recipients = admins.filter((u) => human.has(u));
    if (recipients.length === 0) {
      logger.error(
        { documentId, number: d.number, project: d.from },
        'channel: a document waits at its approve gate and its project has no admin to approve it',
      );
      return;
    }
    await ecosystemSignals().notify({
      recipients,
      projectId: d.from,
      type: 'channel_gate_pending',
      title: `${d.number} waits for your approval: ${d.subject}`,
      body: `A ${d.type} this project wrote is held at the approve gate until an admin approves or returns it.`,
      resolutionKey: gateKey(documentId),
    });
  });
}

export async function announceGateDecided(documentId: string, d: ChannelDocument): Promise<void> {
  await signal('channel_gate_pending', async () =>
    ecosystemSignals().resolve(gateKey(documentId), await gateOutcome(d)),
  );
  if (d.state === 'published') await announcePublished(documentId, d);
}
