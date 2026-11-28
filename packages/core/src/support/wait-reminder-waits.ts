// What one project's morning reminder lists (ISS-1343, owner 2026-11-19): every decision its Needs
// you holds for a person, read as each person who may owe one, and kept once with everyone it waits
// on. Each wait is named by its own words, aged from when it was last touched, and linked to the
// Forge page that opens it. Which waits are due, and when a project's morning falls, are the pure
// halves the sweep (`wait-reminder.ts`) and its tests share.

import type { NeedsYouDecision } from '@forge/contracts/needs-you-decisions';
import {
  WAIT_REMINDER_DEFAULTS,
  WAIT_REMINDER_MIN_AGE_HOURS,
  type WaitReminder,
} from '@forge/contracts/support-technical';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { readNeedsYouDecisions } from '../assistant/index.js';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { agentQuestions } from '../db/schema-questions.js';
import { assistantSpeakerLinks } from '../db/schema-speaker-links.js';
import { supportActions } from '../db/schema-support.js';
import { webBaseUrl } from '../lib/web-base-url.js';
import { zonedClock } from '../lib/zoned-clock.js';
import { namedHolders } from '../permissions/index.js';
import { waitedToPropose } from '../questions/index.js';
import { plainWords, titleWords } from './room-read-words.js';

/** One person a wait is on: their name, and the chat name they are mentioned by where one is known. */
export interface Ower {
  userId: string;
  name: string;
  mention: string | null;
}

/** One wait as the reminder lists it. */
export interface Wait {
  /** The decision's id in the Needs you read: what the reminder names it by. */
  id: string;
  ask: string;
  recommended: string | null;
  /** When it was last touched, ISO; null where the record holds no time. */
  since: string | null;
  owes: Ower[];
  /** The Forge page that opens it, absolute. */
  link: string;
  /** Waited past the day-14 escalation (`questions/decision-age.ts:waitedToPropose`). */
  escalated: boolean;
}

const HOUR_MS = 3_600_000;

/** A project's reminder with every part named. */
export interface ReminderSetting {
  on: boolean;
  hour: number;
  timeZone: string;
}

/** The reminder a project's document names, every unnamed part its default (on, 08:00 Asia/Ho_Chi_Minh). */
export const reminderOf = (named: WaitReminder | undefined): ReminderSetting => ({
  on: named?.on ?? WAIT_REMINDER_DEFAULTS.on,
  hour: named?.hour ?? WAIT_REMINDER_DEFAULTS.hour,
  timeZone: named?.timeZone ?? WAIT_REMINDER_DEFAULTS.timeZone,
});

/** `now` in `timeZone`: its day (`YYYY-MM-DD`) and its hour (0-23). */
export function localDay(now: Date, timeZone: string): { day: string; hour: number } {
  const at = zonedClock(timeZone, now);
  const two = (n: number) => String(n).padStart(2, '0');
  return { day: `${at.year}-${two(at.month)}-${two(at.day)}`, hour: at.hour };
}

/** The day whose morning is due for a project now, or null: off, or before its hour today. */
export function morningDue(reminder: ReminderSetting, now: Date): string | null {
  if (!reminder.on) return null;
  const { day, hour } = localDay(now, reminder.timeZone);
  return hour >= reminder.hour ? day : null;
}

/**
 * The waits a morning lists, oldest first: each open at least 12 hours. One the record gives no
 * time is listed, last, since nothing shows it is young; one younger waits for the next morning.
 */
export function dueWaits(waits: readonly Wait[], now: Date): Wait[] {
  const cut = now.getTime() - WAIT_REMINDER_MIN_AGE_HOURS * HOUR_MS;
  const at = (w: Wait) => (w.since ? Date.parse(w.since) : Number.POSITIVE_INFINITY);
  return waits
    .filter((w) => w.since === null || Date.parse(w.since) <= cut)
    .sort((a, b) => at(a) - at(b));
}

/** How long a wait has waited, in whole days or hours. */
export function ageOf(since: string | null, now: Date): string {
  if (!since) return 'age unknown';
  const hours = Math.floor((now.getTime() - Date.parse(since)) / HOUR_MS);
  return hours >= 48 ? `${Math.floor(hours / 24)} days` : `${hours} hours`;
}

// the web app's origin, as every link support writes back to Forge takes it; a morning is refused
// SUPPORT_REMINDER_NO_WEB before it is handed where there is none (`wait-reminder.ts:fireProject`)
const base = () => webBaseUrl() ?? '';

/** The Forge page a decision opens on: its issue by documentId, its own item, else the project's approvals. */
function linkOf(slug: string, d: NeedsYouDecision, issueOf: ReadonlyMap<string, string>): string {
  const project = `${base()}/projects/${slug}`;
  const issue = d.entity === 'question' ? issueOf.get(d.key) : undefined;
  if (issue) return `${project}/issues/${issue}`;
  const pages = {
    requirement: 'requirements',
    feedback: 'feedback',
    release: 'releases',
    workflow: 'workflows',
    contract: 'contracts',
  } as const;
  if (d.opens) return `${project}/${pages[d.opens.kind]}/${encodeURIComponent(d.opens.key)}`;
  return `${project}/approvals`;
}

/** The issue each question decision is asked on, by documentId. */
async function questionIssues(keys: readonly string[]): Promise<Map<string, string>> {
  const ids = keys.filter((k) => /^[0-9a-f-]{36}$/i.test(k));
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: agentQuestions.id, issue: issues.id })
    .from(agentQuestions)
    .innerJoin(issues, eq(issues.id, agentQuestions.issueId))
    .where(inArray(agentQuestions.id, ids));
  return new Map(rows.map((r) => [r.id, r.issue]));
}

/**
 * The chat name a Forge user is mentioned by on a chat server (`namespace`): the label of their
 * confirmed link, else the name they last wrote under there; null where they hold no link.
 */
async function mentionsOf(
  userIds: readonly string[],
  namespace: string | null,
): Promise<Map<string, string>> {
  if (!namespace || userIds.length === 0) return new Map();
  const links = await db
    .select({
      userId: assistantSpeakerLinks.userId,
      key: assistantSpeakerLinks.externalId,
      label: assistantSpeakerLinks.externalLabel,
    })
    .from(assistantSpeakerLinks)
    .where(
      and(
        eq(assistantSpeakerLinks.source, 'rocketchat'),
        eq(assistantSpeakerLinks.externalNamespace, namespace),
        inArray(assistantSpeakerLinks.userId, [...userIds]),
      ),
    );
  const out = new Map<string, string>();
  for (const link of links) {
    if (link.label) {
      out.set(link.userId, link.label);
      continue;
    }
    const [seen] = await db
      .select({ label: supportActions.actorLabel })
      .from(supportActions)
      .where(and(eq(supportActions.actorKey, link.key), isNotNull(supportActions.actorLabel)))
      .limit(1);
    if (seen?.label) out.set(link.userId, seen.label);
  }
  return out;
}

/**
 * Every decision of `projectId` a person owes, once each with everyone it waits on: read as each
 * person who may owe one (a member or a release approver), the Needs you read each of them sees.
 */
export async function projectWaits(
  projectId: string,
  slug: string,
  namespace: string | null,
  now: Date,
): Promise<Wait[]> {
  const people = new Map<string, string>();
  for (const permission of ['project.write', 'releases.approve'] as const) {
    for (const h of await namedHolders(permission, projectId)) {
      if (h.kind === 'human') people.set(h.id, h.name);
    }
  }
  const byId = new Map<string, { d: NeedsYouDecision; owes: string[] }>();
  for (const userId of people.keys()) {
    for (const d of await readNeedsYouDecisions(projectId, userId)) {
      const held = byId.get(d.id);
      if (held) held.owes.push(userId);
      else byId.set(d.id, { d, owes: [userId] });
    }
  }
  const held = [...byId.values()];
  const issueOf = await questionIssues(held.map(({ d }) => d.key));
  const mentions = await mentionsOf([...people.keys()], namespace);
  return held.map(({ d, owes }) => {
    const recommendedLabel = d.answers.find((a) => a.id === d.recommended?.answerId)?.label;
    return {
      id: d.id,
      ask:
        d.entity === 'question'
          ? titleWords(d.question, 'question')
          : titleWords(d.title, 'decision'),
      recommended: recommendedLabel ? plainWords(recommendedLabel, 'its recommended answer') : null,
      since: d.touchedAt,
      owes: owes.map((userId) => ({
        userId,
        name: people.get(userId) ?? userId,
        mention: mentions.get(userId) ?? null,
      })),
      link: linkOf(slug, d, issueOf),
      escalated: waitedToPropose(d.touchedAt, now),
    };
  });
}
