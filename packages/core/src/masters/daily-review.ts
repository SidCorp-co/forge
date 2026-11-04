// A project's daily review (ISS-862; owner, 2026-11-01: every day a report of what happened, and the
// agents finding problems to fix, optimise or build on their own). A `daily_review` schedule's fire
// hands the project's live master a goal-based brief, typed into its pane as a nudge through the
// session inbox every live session takes input by (`agent-sessions/session-send.ts`). Core writes
// the goal, the window and where to read the facts; the master writes the report itself, in its own
// words (agent-is-the-voice), and hunts. A fire with no master to tell is missed, by name.

import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import type { DailyReviewFireRefusal } from '@forge/contracts/schedules';
import { sql } from 'drizzle-orm';
import { requestSessionSend } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { masterSilentSql } from '../devices/index.js';

const rowsOf = <T>(r: unknown) => [...(r as Iterable<T>)];

/** The project's own thread in an operations room, as the room's binding records it (ISS-934). */
export interface ProjectThreadRef {
  rid: string;
  thread: string;
}

/** What one daily review fire came to. */
export type DailyReviewDelivery =
  | { kind: 'delivered'; sessionId: string; published: boolean }
  | { kind: 'missed'; code: DailyReviewFireRefusal; detail: string };

/** The window a review covers: the day before the fire. */
const WINDOW_MS = 24 * 60 * 60 * 1000;

interface MasterRow {
  id: string;
  silent: boolean;
  device_name: string | null;
}

/** The project's live master sessions, the one whose box spoke last first. */
async function liveMasters(projectId: string): Promise<MasterRow[]> {
  const terminal = sql.join(
    terminalAgentSessionStatuses.map((s) => sql`${s}`),
    sql`, `,
  );
  return rowsOf<MasterRow>(
    await db.execute(sql`
      SELECT s.id, ${masterSilentSql('s')} AS silent, d.name AS device_name
        FROM agent_sessions s
        LEFT JOIN devices d ON d.id = s.device_id
       WHERE s.project_id = ${projectId}
         AND s.kind = ${MASTER_SESSION_KIND}
         AND s.status NOT IN (${terminal})
       ORDER BY ${masterSilentSql('s')} ASC, s.created_at DESC`),
  );
}

/** The brief: a goal, the window and where its facts are read. Never the report itself. */
export function dailyReviewBrief(args: {
  projectId: string;
  slug: string;
  since: Date;
  until: Date;
  threads: readonly ProjectThreadRef[];
}): string {
  const at = (path: string) => `/api/projects/${args.projectId}${path}`;
  return [
    `Daily review for ${args.slug}, ${args.since.toISOString()} to ${args.until.toISOString()} (ISS-862).`,
    "Goal: tell the owner how the project's day went, short, in Vietnamese, in your own words, in the project's Forge-Communicate thread: what shipped and is live, what is in flight, what is blocked and on whom, and what you found and folded into the next batch.",
    'Then hunt on your own for what to fix, optimise or build: Sentry errors, production logs and slow endpoints, failed or flaky runs, UX rough edges, debt, and your own backlog. File or fix what you find, and fold it into the running batch.',
    "Audit (owner, 2026-11-02, product-delivery-audit-loop): read the day's channel conversations and how each ended (who asked, what the agent answered, what was left open or answered wrong), turn what you find into product items (feedback, a requirement revision) folded into the next batch, and raise a decision only the owner can take in this project's Forge-Communicate thread, never in a room its users read.",
    `Facts: ${at('/releases')} · ${at('/runs/standing?scope=finished')} · ${at('/runs/standing?scope=live')} · ${at('/issues/standing?scope=open')} · ${at('/integrations/sentry/issues')} · ${at('/support/rooms')} · ${at('/support/turns')} · ${at('/support/rooms/<roomId>/actions')}.`,
    `Learning (ISS-867): say what the day taught, the lessons approved and the approved lessons whose mistake was made again, from ${at(`/lessons/learned?since=${args.since.toISOString()}&until=${args.until.toISOString()}`)}; read a lesson by its slug at ${at('/knowledge/<slug>')}. A repeat is a lesson an agent did not apply: find why (not read, unclear, wrongly scoped) and fix that, or report a confusion on it.`,
    postLine(at('/support/master-posts'), args.slug, args.threads),
  ].join('\n');
}

/**
 * Where the review is posted (ISS-934): the project's own thread in the Forge-Communicate room, as
 * that room's binding records it in `operations.threads`. With none recorded, a post there is refused
 * by name, so the line says where to record one first.
 */
function postLine(door: string, slug: string, threads: readonly ProjectThreadRef[]): string {
  if (threads.length === 0) {
    return `Post: no Forge-Communicate thread is recorded for ${slug}, so a post there is refused SUPPORT_PROJECT_THREAD_UNRECORDED and never lands at its top level: record it first as \`operations.threads["<rid>"]["${slug}"]\` on that room's binding, then POST ${door} { text, rid }. Never post in a room whose readers are users.`;
  }
  const where = threads.map((t) => `thread ${t.thread} of room ${t.rid}`).join(', or ');
  return `Post: POST ${door} { text, rid }, rid naming the Forge-Communicate room: it lands in this project's own ${where}, never at the room's top level and never in a room whose readers are users.`;
}

/** Hand the project's master its review brief, or say by name why no master took it. */
export async function deliverDailyReview(args: {
  projectId: string;
  slug: string;
  fireId: string;
  at: Date;
  threads: readonly ProjectThreadRef[];
}): Promise<DailyReviewDelivery> {
  const masters = await liveMasters(args.projectId);
  const master = masters[0];
  if (!master) {
    return {
      kind: 'missed',
      code: 'DAILY_REVIEW_NO_MASTER',
      detail: `${args.slug} has no live master session to hand the daily review to: the review was missed, and the next fire tries again`,
    };
  }
  if (master.silent) {
    return {
      kind: 'missed',
      code: 'DAILY_REVIEW_MASTER_SILENT',
      detail: `${args.slug}'s master session ${master.id}${master.device_name ? ` on ${master.device_name}` : ''} has gone silent: the daily review was missed, and the next fire tries again`,
    };
  }
  const { published } = await requestSessionSend({
    agentSessionId: master.id,
    kind: 'inject',
    intentId: `daily-review:${args.fireId}`,
    body: dailyReviewBrief({
      projectId: args.projectId,
      slug: args.slug,
      since: new Date(args.at.getTime() - WINDOW_MS),
      until: args.at,
      threads: args.threads,
    }),
  });
  return { kind: 'delivered', sessionId: master.id, published };
}
