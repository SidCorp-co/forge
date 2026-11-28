// One shared picture between a room agent and the masters (ISS-1243 item 20, owner 2026-11-15: the
// agent and the master stay in step, so neither tells the person what the other contradicts and
// neither asks what the other already knows). The agent reads, for its thread and its asker, what
// the masters have in flight: each item filed from those threads, the issues carrying it, each
// issue's step, its ETA as the forecast holds it, and where it landed; the promises it made there;
// and the asks it put to a master with their answers. A master reads its project's rooms' open
// threads: who asked, whether a person waits on a reply, and the promises, items and asks open there.

import type { Forecast } from '@forge/contracts/forecast';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { asksOfThread, type MasterAskView } from './master-ask.js';
import { knownThread, type Outcome, threadUnknown } from './outcome.js';
import { roomSay, roomWho } from './room-voice.js';
import { type RoomRow, roomsOfProject, threadMembers } from './store.js';
import { TOP_LEVEL } from './thread.js';

/** An issue's ETA as its forecast holds it: dates where it has them, else why it has none. */
export interface IssueEta {
  likelyBy: string | null;
  latestBy: string | null;
  says: string;
}

let forecastReader: ((projectId: string, issSeq: number) => Promise<Forecast | null>) | null = null;

/** The composition root hands the forecast read in, which this module may not import. */
export function provideIssueForecastReader(
  reader: (projectId: string, issSeq: number) => Promise<Forecast | null>,
): void {
  forecastReader = reader;
}

/** What a forecast says of when an issue is done; never a date it does not hold. */
export function etaOf(f: Forecast | null): IssueEta {
  if (!f) return { likelyBy: null, latestBy: null, says: 'no forecast was read for it' };
  switch (f.kind) {
    case 'forecast':
      return {
        likelyBy: f.p50At,
        latestBy: f.p85At,
        says: `likely done by ${f.p50At.slice(0, 10)}, at the latest ${f.p85At.slice(0, 10)}${f.waitsOn.length ? `; it waits on ${f.waitsOn.join(', ')} first` : ''}`,
      };
    case 'paused':
      return {
        likelyBy: null,
        latestBy: null,
        says: `no date: it waits on ${roomWho(f.says.who)} to ${roomSay(f.says.act)} (${roomSay(f.says.reason)})`,
      };
    case 'not_enough_history':
      return {
        likelyBy: null,
        latestBy: null,
        says: `no date: the forecast has ${f.n} of the ${f.floor} landed issues it needs`,
      };
    case 'landed':
      return { likelyBy: null, latestBy: null, says: 'landed; nothing more runs on it' };
    case 'ended':
      return { likelyBy: null, latestBy: null, says: `ended as ${f.status} without landing` };
  }
}

interface InFlightIssue {
  key: string;
  project: string;
  title: string;
  status: string;
  step: string | null;
  eta: IssueEta;
  landed: { commit: string | null; target: string | null; at: string } | null;
}

interface InFlightItem {
  thread: string;
  feedback: string;
  project: string;
  phase: string;
  issues: InFlightIssue[];
}

export interface InFlight {
  thread: string;
  asker: { key: string; label: string | null } | null;
  /** Items filed from this thread and the asker's other threads in this room, with their issues. */
  items: InFlightItem[];
  promises: { thread: string; issue: string; environment: string; state: string }[];
  asks: MasterAskView[];
  next: string;
}

type ItemRow = {
  thread: string;
  feedback: string;
  project: string;
  phase: string;
  issue_project_id: string | null;
  iss_seq: number | null;
  issue: string | null;
  issue_project: string | null;
  title: string | null;
  status: string | null;
  step: string | null;
  merged_commit_sha: string | null;
  merged_target: string | null;
  merged_at: Date | string | null;
};

/** The threads of this room the asker wrote in, this one first. */
async function askerThreads(room: RoomRow, thread: string, askerKey: string | null) {
  if (!askerKey) return [thread];
  const rows = (await db.execute(sql`
    SELECT DISTINCT thread FROM support_actions
     WHERE room_id = ${room.id} AND kind = 'message_in' AND actor_kind = 'member'
       AND actor_key = ${askerKey} AND thread <> ${thread}
     LIMIT 50
  `)) as unknown as { thread: string }[];
  return [thread, ...rows.map((r) => r.thread)];
}

/** The ETAs of the unlanded issues named, read once per issue, at most `cap` of them. */
async function etasOf(rows: ItemRow[], cap = 8): Promise<Map<string, IssueEta>> {
  const etas = new Map<string, IssueEta>();
  const open = rows.filter(
    (r) => r.issue && r.iss_seq !== null && r.issue_project_id && !r.merged_at,
  );
  for (const r of open.slice(0, cap)) {
    const key = `${r.issue_project_id}:${r.iss_seq}`;
    if (etas.has(key) || !r.issue_project_id || r.iss_seq === null) continue;
    etas.set(
      key,
      etaOf(forecastReader ? await forecastReader(r.issue_project_id, r.iss_seq) : null),
    );
  }
  return etas;
}

/**
 * What the masters have in flight for this thread and its asker (its first writer): the agent reads
 * it before it answers, and never tells the person what it says otherwise. Nothing is posted.
 */
export async function inFlightOf(room: RoomRow, thread: string): Promise<Outcome<InFlight>> {
  if (!(await knownThread(room, thread))) return threadUnknown(thread);
  const [first] = await threadMembers(room.id, thread);
  const threads = await askerThreads(room, thread, first?.key ?? null);
  const threadList = sql.join(
    threads.map((t) => sql`${t}`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT l.thread, 'FB-' || f.fb_seq AS feedback, fp.slug AS project, l.last_phase AS phase,
           i.project_id AS issue_project_id, i.iss_seq,
           CASE WHEN i.id IS NULL THEN NULL
                ELSE COALESCE(ip.issue_prefix, 'ISS') || '-' || i.iss_seq END AS issue,
           ip.slug AS issue_project, i.title, i.status, ws.step,
           i.merged_commit_sha, i.merged_target, i.merged_at
      FROM support_feedback_links l
      JOIN feedback f ON f.id = l.feedback_id
      JOIN projects fp ON fp.id = l.project_id
      LEFT JOIN feedback_route_issues r ON r.feedback_id = l.feedback_id
      LEFT JOIN issues i ON i.id = r.issue_id
      LEFT JOIN projects ip ON ip.id = i.project_id
      LEFT JOIN issue_work_state ws ON ws.issue_id = i.id
     WHERE l.room_id = ${room.id} AND l.thread IN (${threadList})
     ORDER BY l.created_at DESC, i.iss_seq
     LIMIT 100
  `)) as unknown as ItemRow[];
  const etas = await etasOf(rows);
  const items = new Map<string, InFlightItem>();
  for (const r of rows) {
    const id = `${r.project}:${r.feedback}`;
    const item = items.get(id) ?? {
      thread: r.thread,
      feedback: r.feedback,
      project: r.project,
      phase: r.phase,
      issues: [],
    };
    items.set(id, item);
    if (!r.issue || !r.issue_project || !r.title || !r.status) continue;
    item.issues.push({
      key: r.issue,
      project: r.issue_project,
      title: r.title,
      status: r.status,
      step: r.step,
      eta: r.merged_at
        ? etaOf({ kind: 'landed' } as Forecast)
        : (etas.get(`${r.issue_project_id}:${r.iss_seq}`) ?? etaOf(null)),
      landed: r.merged_at
        ? {
            commit: r.merged_commit_sha,
            target: r.merged_target,
            at: new Date(r.merged_at).toISOString(),
          }
        : null,
    });
  }
  const promises = (await db.execute(sql`
    SELECT p.thread, COALESCE(ip.issue_prefix, 'ISS') || '-' || i.iss_seq AS issue,
           p.environment, p.state
      FROM support_promises p
      JOIN issues i ON i.id = p.issue_id
      JOIN projects ip ON ip.id = i.project_id
     WHERE p.room_id = ${room.id} AND p.thread IN (${threadList})
     ORDER BY p.created_at DESC
     LIMIT 50
  `)) as unknown as InFlight['promises'];
  return {
    ok: true,
    value: {
      thread,
      asker: first ? { key: first.key, label: first.label ?? null } : null,
      items: [...items.values()],
      promises,
      asks: await asksOfThread(room, thread),
      next: 'Nothing was posted. This is what is already in flight for this thread and its asker: say nothing that contradicts it, and use support.ask_master only for what it does not already answer.',
    },
  };
}

/** One open thread of a room, as its project's master reads it. */
interface AgentThread {
  rid: string;
  roomKind: string;
  thread: string;
  asker: string | null;
  lastMemberAt: string | null;
  lastPostAt: string | null;
  /** A person wrote after the agent's last post, or the agent never posted. */
  awaitingReply: boolean;
  openPromises: { issue: string; environment: string; asker: string | null }[];
  openItems: string[];
  openAsks: number;
}

/**
 * The open threads of the rooms `projectId` binds, last week's, newest first: where a person waits on
 * a reply, a promise stands, an item filed there is not yet told its result, or an ask of a master
 * waits. The master reads it before it posts or answers in a room, and never repeats or contradicts
 * what was promised there.
 */
export async function agentThreadsOf(projectId: string): Promise<{ threads: AgentThread[] }> {
  const rooms = await roomsOfProject(projectId);
  const threads: AgentThread[] = [];
  for (const room of rooms) {
    const rows = (await db.execute(sql`
      WITH recent AS (
        SELECT a.thread,
               (array_agg(a.actor_label ORDER BY a.created_at)
                  FILTER (WHERE a.kind = 'message_in' AND a.actor_kind = 'member'))[1] AS asker,
               max(a.created_at) FILTER (WHERE a.kind = 'message_in' AND a.actor_kind = 'member') AS last_member_at,
               max(a.created_at) FILTER (WHERE a.kind = 'reply') AS last_post_at
          FROM support_actions a
         WHERE a.room_id = ${room.id} AND a.created_at > now() - interval '7 days'
           AND a.thread <> ${TOP_LEVEL}
         GROUP BY a.thread
      )
      SELECT r.thread, r.asker, r.last_member_at, r.last_post_at,
             COALESCE((SELECT json_agg(json_build_object(
                         'issue', COALESCE(ip.issue_prefix, 'ISS') || '-' || i.iss_seq,
                         'environment', p.environment, 'asker', p.asker_label))
                         FROM support_promises p JOIN issues i ON i.id = p.issue_id
                         JOIN projects ip ON ip.id = i.project_id
                        WHERE p.room_id = ${room.id} AND p.thread = r.thread AND p.state = 'open'), '[]') AS open_promises,
             COALESCE((SELECT array_agg('FB-' || f.fb_seq ORDER BY f.fb_seq)
                         FROM support_feedback_links l JOIN feedback f ON f.id = l.feedback_id
                        WHERE l.room_id = ${room.id} AND l.thread = r.thread AND l.closed_at IS NULL), '{}') AS open_items,
             (SELECT count(*)::int FROM support_master_asks k
               WHERE k.room_id = ${room.id} AND k.thread = r.thread AND k.answered_at IS NULL) AS open_asks
        FROM recent r
       ORDER BY greatest(r.last_member_at, r.last_post_at) DESC NULLS LAST
       LIMIT 100
    `)) as unknown as {
      thread: string;
      asker: string | null;
      last_member_at: Date | string | null;
      last_post_at: Date | string | null;
      open_promises: AgentThread['openPromises'];
      open_items: string[];
      open_asks: number;
    }[];
    for (const r of rows) {
      const member = r.last_member_at ? new Date(r.last_member_at) : null;
      const post = r.last_post_at ? new Date(r.last_post_at) : null;
      const awaitingReply = member !== null && (post === null || member > post);
      const open =
        awaitingReply || r.open_promises.length > 0 || r.open_items.length > 0 || r.open_asks > 0;
      if (!open) continue;
      threads.push({
        rid: room.rid,
        roomKind: room.kind,
        thread: r.thread,
        asker: r.asker,
        lastMemberAt: member?.toISOString() ?? null,
        lastPostAt: post?.toISOString() ?? null,
        awaitingReply,
        openPromises: r.open_promises,
        openItems: r.open_items,
        openAsks: r.open_asks,
      });
    }
  }
  return { threads };
}
