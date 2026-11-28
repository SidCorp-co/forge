// The morning reminder of what waits on a person (ISS-1343, owner 2026-11-19: every morning, every
// wait older than 12 hours, in each project's own thread of the shared operations room). Each morning, at
// the hour the project document's `waitReminder` names (08:00 Asia/Ho_Chi_Minh by default), core
// re-reads every wait of the project, and where any has stood 12 hours or more it hands them, once
// that day, to the agent who writes in the project's technical channel: the operations room's
// session for the project's thread there, else the project's own room's session for a direct message
// to its owner (`technical-channel.ts:technicalChannelOf`). Core writes no word of the post (ISS-873):
// the agent re-reads each, leaves out what the record already settles, and answers with
// `support.check_result`, one post or none (`wait-reminder-post.ts`). A project whose waits have no
// agent to write them is refused by name, on the bell of each person they wait on, never dropped.
// A wait repeats every morning until the record settles it; there is no other timed reminder.

import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { supportActions } from '../db/schema-support.js';
import { logger } from '../lib/logger.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import { emitNotification } from '../notifications/index.js';
import { readProjectDocument } from '../project-config/index.js';
import { deliverWaiting } from './dispatch.js';
import { grantsOf, supportConfigOf } from './grants.js';
import { no, type Outcome } from './outcome.js';
import { sharedRoomOf } from './project-thread.js';
import { type Refusal, refusalOf } from './refusals.js';
import { titleWords } from './room-read-words.js';
import { checkThreadOf } from './rules.js';
import { insertAction, type RoomRow, roomsOfProject } from './store.js';
import { technicalChannelOf } from './technical-channel.js';
import { roomAuth } from './thread.js';
import {
  ageOf,
  dueWaits,
  morningDue,
  projectWaits,
  reminderOf,
  type Wait,
} from './wait-reminder-waits.js';

/** Where a project's reminder is written: the shared room's thread, or a direct message to its owner. */
export interface ReminderRoute {
  kind: 'thread' | 'dm';
  /** The room whose session writes it, and whose bot posts it. */
  room: RoomRow;
}

/** The firing a reminder is handed as, kept on its `message_in` so its post reads what was listed. */
export interface ReminderFiring {
  projectId: string;
  slug: string;
  route: ReminderRoute['kind'];
  waits: Wait[];
}

/** The scheduled check a project's reminder fires as: `check:waits-<slug>:<day>`. */
export const reminderCheckOf = (slug: string) => `waits-${slug}`;

/** The projects whose morning this process settled, by day, so a settled one is not read again. */
const settledToday = new Map<string, string>();

/** Forget what this process settled: a test's fresh morning. */
export function forgetSettledMornings(): void {
  settledToday.clear();
}

const PATH = '/waitReminder';

/** The project's own room holding a session, its owner's room first, for a direct message. */
async function ownRoomOf(projectId: string): Promise<RoomRow | null> {
  const rooms = (await roomsOfProject(projectId)).filter((r) => r.sessionId);
  for (const room of rooms) {
    const config = await supportConfigOf(room);
    if (config?.ownerRoom === room.rid && grantsOf(config).owner) return room;
  }
  for (const room of rooms) {
    if (grantsOf(await supportConfigOf(room)).owner) return room;
  }
  return null;
}

/** Where the project's reminder is written, or the refusal naming why it can be written nowhere. */
export async function reminderRouteOf(projectId: string): Promise<Outcome<ReminderRoute>> {
  if ((await technicalChannelOf(projectId)).kind === 'thread') {
    const shared = await sharedRoomOf(projectId);
    if (!shared) {
      return no(
        'SUPPORT_TECHNICAL_CHANNEL_UNNAMED',
        PATH,
        "the project's technical channel is its thread of the operations room its organization shares, and the organization binds none; bind one, or name a direct message in the project document's `technicalChannel`",
      );
    }
    if (!shared.sessionId) {
      return no(
        'SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE',
        PATH,
        `the operations room ${shared.rid} the organization shares holds no agent session to write the reminder; warm its session`,
      );
    }
    return { ok: true, value: { kind: 'thread', room: shared } };
  }
  const own = await ownRoomOf(projectId);
  if (!own) {
    return no(
      'SUPPORT_TECHNICAL_CHANNEL_UNREACHABLE',
      PATH,
      "the project's technical channel is a direct message, and no room of the project holds an agent session whose binding names the owner to write it to; bind one, or bind an operations room the organization shares",
    );
  }
  return { ok: true, value: { kind: 'dm', room: own } };
}

/** One wait as the agent is handed it: the record's facts, by name, never its words for him. */
function waitLine(w: Wait, n: number, now: Date): string {
  const owes = w.owes.map((o) => (o.mention ? `@${o.mention}` : o.name)).join(', ');
  const parts = [
    `${n}. waited ${ageOf(w.since, now)}`,
    `owed by: ${owes || 'nobody named'}`,
    `link: ${w.link}`,
  ];
  if (w.escalated) {
    parts.push('waited past 14 days: propose deferring or dropping it, recommending the defer');
  }
  // its ask and recommendation are their writer's words (a master's or a run's), framed (ISS-1425)
  const words = `asks: ${w.ask}\nrecommended: ${w.recommended ?? 'none on record'}`;
  return `${parts.join(' · ')}\n${markUntrusted(words, { source: 'the wait as its writer put it' })}`;
}

/** What the agent is handed: what to do, then the waits as the record holds them, oldest first. */
export function reminderNote(
  thread: string,
  project: { name: string; slug: string },
  route: ReminderRoute['kind'],
  waits: readonly Wait[],
  now: Date,
): string {
  const where =
    route === 'thread'
      ? `the project's own thread of this operations room`
      : `a direct message to the project's owner`;
  return [
    `Morning reminder for ${titleWords(project.name, 'project')} (${project.slug}): ${waits.length} waits on a person have stood 12 hours or more.`,
    `Answer it with support.check_result { check: "${thread}", finding }: one post, in ${where}, once this morning; finding null when nothing is left to remind, and nothing is posted.`,
    `First re-read each with support.issues, support.requirements and support.releases { project: "${project.slug}" }, and leave out what the record already settles; settle it with the act that fits where you can. In the reader's language and your own words, each wait oldest first: how long it waited, its ask in one line, the recommended option, @-mention whoever owes it, and its link behind your own words, [what it is](link), never the bare address or an id.`,
    'A reply to it in the thread is the answer of whoever wrote it: take it as them, citing their message, with the act that fits.',
    'Waits:',
    ...waits.map((w, i) => waitLine(w, i + 1, now)),
  ].join('\n');
}

/** The firing of `thread` in `room` already recorded: one morning is handed once, by any core. */
async function fired(room: RoomRow, thread: string): Promise<boolean> {
  const [row] = await db
    .select({ id: supportActions.id })
    .from(supportActions)
    .where(
      and(
        eq(supportActions.roomId, room.id),
        eq(supportActions.kind, 'message_in'),
        eq(supportActions.thread, thread),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** A morning whose waits can be written nowhere: refused by name on the bell of each person owed. */
async function tellUnreached(
  project: { id: string; name: string },
  day: string,
  waits: readonly Wait[],
  refusal: Refusal,
): Promise<void> {
  const recipients = [...new Set(waits.flatMap((w) => w.owes.map((o) => o.userId)))];
  logger.warn(
    { projectId: project.id, code: refusal.code, waits: waits.length },
    'support: a morning reminder has nowhere to go',
  );
  if (recipients.length === 0) return;
  await emitNotification({
    recipients,
    projectId: project.id,
    type: 'ops_alert',
    severity: 'warning',
    title: `${project.name}: reminder not sent`,
    body: `${waits.length} waits were not reminded in chat. ${refusal.code}: ${refusal.detail}.`,
    dedupeKey: `wait-reminder:${project.id}:${day}`,
    resolutionKey: `wait-reminder-unreached:${project.id}`,
  });
}

const NO_WEB = refusalOf(
  'SUPPORT_REMINDER_NO_WEB',
  PATH,
  'this Forge knows no address of its web app (CORS_ORIGINS is unset), so no wait has a page to link to; set CORS_ORIGINS to the web app origin',
);

/** One project's morning: handed once where it is due and anything waits, refused by name where it cannot go. */
async function fireProject(
  project: { id: string; slug: string; name: string },
  now: Date,
): Promise<boolean> {
  const day = morningDue(
    reminderOf((await readProjectDocument(project.id))?.document.waitReminder),
    now,
  );
  if (!day || settledToday.get(project.id) === day) return false;
  settledToday.set(project.id, day);
  const thread = checkThreadOf(reminderCheckOf(project.slug), day);
  const route = await reminderRouteOf(project.id);
  if (route.ok && (await fired(route.value.room, thread))) return false;
  const namespace = route.ok ? (await roomAuth(route.value.room)).namespace : null;
  const waits = dueWaits(await projectWaits(project.id, project.slug, namespace, now), now);
  if (waits.length === 0) return false;
  if (!webBaseUrl()) {
    // every wait is handed with its page's link: with no web address they would open nowhere
    await tellUnreached(project, day, waits, NO_WEB);
    return false;
  }
  if (!route.ok) {
    const [refusal] = route.refusals;
    if (refusal) await tellUnreached(project, day, waits, refusal);
    return false;
  }
  const { room, kind } = route.value;
  const firing: ReminderFiring = {
    projectId: project.id,
    slug: project.slug,
    route: kind,
    waits,
  };
  const row = await insertAction({
    roomId: room.id,
    projectId: room.projectId,
    conversationId: null,
    thread,
    kind: 'message_in',
    actorKind: 'core',
    input: {
      note: reminderNote(thread, project, kind, waits, now),
      check: reminderCheckOf(project.slug),
      reminder: firing,
    },
    externalId: thread,
  });
  if (!row) return false;
  await deliverWaiting(room.id).catch((err) =>
    logger.error({ err, roomId: room.id, thread }, 'support: a morning reminder was not handed on'),
  );
  return true;
}

/**
 * The reminders sweep (a process timer, beside the channel checks): every live project whose
 * morning is due is read once that day, and its waits handed where any stood 12 hours.
 */
export async function fireWaitReminders(now = new Date()): Promise<number> {
  const live = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(projects)
    .where(isNull(projects.archivedAt));
  let handed = 0;
  for (const project of live) {
    try {
      if (await fireProject(project, now)) handed += 1;
    } catch (err) {
      settledToday.delete(project.id);
      logger.error({ err, projectId: project.id }, "support: a project's morning reminder failed");
    }
  }
  return handed;
}
