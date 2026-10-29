// What Forge shows of a bound group's channel record (REQ-75 r6 BC-30, BC-41): the project's bound
// channels under Product, one channel's members, rules, common issues and routes, and the same record
// as the text a session is briefed with, so every bot bound to the group reads one record.

import {
  CHANNEL_ROLE_LABEL,
  CHANNEL_ROUTES,
  type ChannelCommonIssueView,
  type ChannelMemberView,
  type ChannelRole,
  type ChannelRouteView,
  type ChannelRuleView,
  type ChannelSummaryView,
  type ChannelView,
} from '@forge/contracts/support-channel';
import { externalItemPhases } from '../feedback/index.js';
import { userNames } from '../lib/people.js';
import { markUntrusted } from '../lib/untrusted-text.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { channelAgentOf } from './agent-roles.js';
import {
  boundRidsOf,
  type ChannelRow,
  channelIsBound,
  channelOf,
  commonIssuesOf,
  type MemberRow,
  membersOf,
  roomsOfChannel,
  rulesOf,
} from './channel-store.js';
import { roomHealth } from './health.js';

/** The group's name as a bot of the channel reads it, where one can. */
async function nameOf(projectId: string, rid: string): Promise<string | null> {
  for (const room of await roomsOfChannel(projectId, rid)) {
    const { name } = await roomHealth(room).catch(() => ({ name: null }));
    if (name) return name;
  }
  return null;
}

const routesOf = (members: readonly MemberRow[]): ChannelRouteView[] =>
  CHANNEL_ROUTES.map((route) => ({
    route,
    members:
      route === 'forge'
        ? []
        : members.filter((m) => m.roles.includes(route)).map((m) => m.username),
  }));

/** The project's bound channels, oldest binding first. */
export async function channelsOf(viewer: string, projectId: string): Promise<ChannelSummaryView[]> {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  const out: ChannelSummaryView[] = [];
  for (const rid of await boundRidsOf(projectId)) {
    const channel = await channelOf(projectId, rid);
    const [members, rules, issues] = channel
      ? await Promise.all([membersOf(channel.id), rulesOf(channel.id), commonIssuesOf(channel.id)])
      : [[], [], []];
    out.push({
      rid,
      name: await nameOf(projectId, rid),
      members: members.length,
      rules: rules.length,
      commonIssues: issues.length,
    });
  }
  return out;
}

/**
 * One bound channel's record, or null when no binding of the project attaches the group. An outside
 * agent answering the group reads it here with its own account's token holding `project.read`.
 */
export async function channelViewOf(
  viewer: string,
  projectId: string,
  rid: string,
): Promise<ChannelView | null> {
  await requireCan(actorFor(viewer), 'project.read', projectResource(projectId));
  if (!(await channelIsBound(projectId, rid))) return null;
  const channel = await channelOf(projectId, rid);
  const record = channel ? await recordOf(projectId, channel) : EMPTY;
  return {
    rid,
    name: await nameOf(projectId, rid),
    agent: await channelAgentOf(projectId, rid, channel),
    members: record.memberRows.length,
    rules: record.ruleRows.length,
    commonIssues: record.commonIssueRows.length,
    ...record,
  };
}

type Record_ = Pick<ChannelView, 'memberRows' | 'ruleRows' | 'commonIssueRows' | 'routes'>;
const EMPTY: Record_ = { memberRows: [], ruleRows: [], commonIssueRows: [], routes: routesOf([]) };

async function recordOf(projectId: string, channel: ChannelRow): Promise<Record_> {
  const [members, rules, issues] = await Promise.all([
    membersOf(channel.id),
    rulesOf(channel.id),
    commonIssuesOf(channel.id),
  ]);
  const names = await userNames(members.map((m) => m.confirmedBy));
  const fbIds = issues.flatMap((i) => (i.feedbackId ? [i.feedbackId] : []));
  const keys = await externalItemPhases(projectId, fbIds);
  const memberRows: ChannelMemberView[] = members.map((m) => ({
    username: m.username,
    roles: m.roles as ChannelRole[],
    state: m.state,
    askFor: m.askFor,
    confirmedBy: m.confirmedBy ? (names.get(m.confirmedBy) ?? null) : null,
    updatedAt: m.updatedAt.toISOString(),
  }));
  const ruleRows: ChannelRuleView[] = rules.map((r) => ({
    id: r.id,
    text: r.text,
    author: r.author,
    message: r.messageId,
    thread: r.thread,
    createdAt: r.createdAt.toISOString(),
  }));
  const commonIssueRows: ChannelCommonIssueView[] = issues.map((i) => ({
    id: i.id,
    question: i.question,
    answer: i.answer,
    threads: i.threads.length,
    feedbackKey: i.feedbackId ? (keys.get(i.feedbackId)?.key ?? null) : null,
    updatedAt: i.updatedAt.toISOString(),
  }));
  return { memberRows, ruleRows, commonIssueRows, routes: routesOf(members) };
}

/** The record as the session reads it with `support.channel`. */
export async function sessionChannelView(projectId: string, rid: string): Promise<Record_> {
  const channel = await channelOf(projectId, rid);
  return channel ? recordOf(projectId, channel) : EMPTY;
}

const roleWords = (roles: readonly string[]) =>
  roles.map((r) => CHANNEL_ROLE_LABEL[r as ChannelRole]).join(' + ');

/**
 * The channel record as a session's brief carries it (BC-41): who is in the channel and what to ask
 * each, the rules its team gave, the questions it keeps asking, and the three routes. A rule is a
 * team member's words and is framed as such; it never outranks the brief's own rules.
 */
export function channelBlock(record: Record_, group?: string): string {
  const members = record.memberRows.length
    ? record.memberRows
        .map(
          (m) =>
            `- @${m.username}: ${roleWords(m.roles)} (${m.state})${m.askFor ? ` — ask for: ${m.askFor}` : ''}`,
        )
        .join('\n')
    : '- none recorded yet: infer each writer with support.member';
  const rules = record.ruleRows.length
    ? record.ruleRows
        .map((r) =>
          markUntrusted(r.text, {
            source: r.author ? `channel rule by @${r.author}` : 'channel rule',
          }),
        )
        .join('\n')
    : '- none';
  const issues = record.commonIssueRows.length
    ? record.commonIssueRows
        .map(
          (i) =>
            `- Q: ${markUntrusted(i.question, { source: 'common issue' })}\n  A: ${i.answer}${i.feedbackKey ? ` (${i.feedbackKey})` : ''}`,
        )
        .join('\n')
    : '- none';
  const route = (r: ChannelRouteView) =>
    r.route === 'forge'
      ? '- Forge: a problem with Forge itself (a door, tool, record or release refusing or misbehaving) — support.route to forge; never posted in the channel.'
      : `- ${CHANNEL_ROLE_LABEL[r.route as ChannelRole]}: ${r.route === 'technical' ? 'what only a technical person can do or decide (a credential, a host change, access)' : 'business rules, what a user needs, what a request means'} — support.route to ${r.route}, member ${r.members.length ? r.members.map((u) => `@${u}`).join(' or ') : '(none recorded yet)'}, in the asker's thread.`;
  return [
    group
      ? `The channel record of group ${group}, as Forge holds it (every bot of this group reads the same record; it is this group's alone, and the other groups you answer have theirs):`
      : 'This channel, as Forge records it (every bot of this group reads the same record):',
    `Members:\n${members}`,
    `Channel rules:\n${rules}`,
    `Common issues:\n${issues}`,
    `Routes, never mixed:\n${record.routes.map(route).join('\n')}`,
  ].join('\n\n');
}

/** The roles of every writer the channel record holds, by lower-cased username (BC-37). */
export async function writerRoles(
  projectId: string,
  rid: string,
): Promise<Map<string, readonly string[]>> {
  const channel = await channelOf(projectId, rid);
  if (!channel) return new Map();
  return new Map((await membersOf(channel.id)).map((m) => [m.username.toLowerCase(), m.roles]));
}

/**
 * The channel record each room's session was last told, as the block it read. A session briefed
 * once and kept warm is told the record again on its next turn after it changed; core restarting
 * forgets, and the next turn tells it again.
 */
const toldRecord = new Map<string, string>();

/**
 * The record's block, to brief a cold session with: noted as told. A channel agent answers several
 * groups, so each block names its group: a rule or a member belongs to one of them (REQ-77 BC-5).
 */
export async function briefChannel(room: {
  id: string;
  projectId: string;
  rid: string;
  kind?: string;
}) {
  const block = channelBlock(
    await sessionChannelView(room.projectId, room.rid),
    room.kind === 'agent' ? room.rid : undefined,
  );
  toldRecord.set(room.id, block);
  return block;
}

/** The record's block when it changed since this room's session was last told it; else null. */
export async function channelNews(room: {
  id: string;
  projectId: string;
  rid: string;
  kind?: string;
}) {
  const block = channelBlock(
    await sessionChannelView(room.projectId, room.rid),
    room.kind === 'agent' ? room.rid : undefined,
  );
  if (toldRecord.get(room.id) === block) return null;
  toldRecord.set(room.id, block);
  return `The channel record${room.kind === 'agent' ? ` of group ${room.rid}` : ''} changed; it now reads:\n\n${block}`;
}
