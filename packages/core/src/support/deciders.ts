// Who a group's channel record names as the person who decides an act (ISS-1000): a rule linked to
// the owner's message, or to the message of a member a person confirmed as Technical or Maintenance,
// that names a member and the acts they decide. That member's own request for one of those acts is
// their agreement to it, so the room's brief and the agreement rule read this one record. A rule from
// anyone else is kept as a rule and names no decider; nobody else's request counts by it.

import type { SupportProposalKind } from '@forge/contracts/support';
import {
  CHANGE_CONFIRM_ROLES,
  CHANNEL_DECIDER_ACT_LABEL,
  CHANNEL_ROLE_LABEL,
  type ChannelDecider,
  type ChannelDeciderView,
  type ChannelRole,
} from '@forge/contracts/support-channel';
import {
  channelOf,
  type MemberRow,
  membersOf,
  type RuleRow,
  roomsOfChannel,
  rulesOf,
} from './channel-store.js';
import { grantsOf, supportConfigOf } from './grants.js';
import type { RoomRow } from './store.js';

type DeciderRule = Pick<RuleRow, 'decider' | 'deciderActs' | 'author' | 'authorKey'>;

/**
 * What makes a rule's decider stand, pure over the record: its writer's account is an owner a room
 * of the channel names (`owners`, by the id the chat server signed), or its writer is a member a
 * person confirmed in a role that may confirm a change. Null for a rule naming no decider, or one
 * whose writer is neither.
 */
export function deciderStanding(
  rule: DeciderRule,
  owners: ReadonlySet<string>,
  members: readonly MemberRow[],
): ChannelDeciderView['by'] {
  if (!rule.decider || !rule.authorKey) return null;
  if (owners.has(rule.authorKey)) return 'owner';
  const name = rule.author?.toLowerCase();
  const writer = name ? members.find((m) => m.username.toLowerCase() === name) : undefined;
  const confirms =
    writer?.state === 'confirmed' &&
    writer.roles.some((r) => CHANGE_CONFIRM_ROLES.includes(r as ChannelRole));
  return confirms ? 'confirmer' : null;
}

/** A rule's decider as the record shows it; null for a rule naming none. */
export function deciderView(
  rule: DeciderRule,
  owners: ReadonlySet<string>,
  members: readonly MemberRow[],
): ChannelDeciderView | null {
  if (!rule.decider || !rule.deciderActs?.length) return null;
  return {
    member: rule.decider,
    acts: [...rule.deciderActs] as SupportProposalKind[],
    by: deciderStanding(rule, owners, members),
  };
}

/** The owners the rooms bound to the group name, by the chat account id each binding holds. */
export async function channelOwners(projectId: string, rid: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const room of await roomsOfChannel(projectId, rid)) {
    const owner = grantsOf(await supportConfigOf(room)).owner;
    if (owner) out.add(owner);
  }
  return out;
}

/** The acts, as the brief and the session's answers name them. */
export const actsWords = (acts: readonly string[]): string =>
  acts.map((a) => CHANNEL_DECIDER_ACT_LABEL[a as SupportProposalKind] ?? a).join(', ');

/** The rule that makes a member the decider of an act, as an agreement names it. */
export interface DeciderRuleFound {
  rule: string;
  /** Who wrote it, by username. */
  author: string | null;
  /** What makes it stand: its writer is the owner, or a member confirmed as Technical or Maintenance. */
  namedBy: 'owner' | 'confirmer';
}

/**
 * The standing rule of the room's channel naming `writer`, by the username the chat server signed,
 * as the one who decides `act`; null where none does.
 */
export async function deciderRuleFor(
  room: Pick<RoomRow, 'projectId' | 'rid'>,
  act: SupportProposalKind,
  writer: { label: string | null },
): Promise<DeciderRuleFound | null> {
  const name = writer.label?.toLowerCase();
  if (!name) return null;
  const channel = await channelOf(room.projectId, room.rid);
  if (!channel) return null;
  const naming = (await rulesOf(channel.id)).filter(
    (r) => r.decider?.toLowerCase() === name && (r.deciderActs ?? []).includes(act),
  );
  if (naming.length === 0) return null;
  const [owners, members] = await Promise.all([
    channelOwners(room.projectId, room.rid),
    membersOf(channel.id),
  ]);
  for (const r of naming) {
    const by = deciderStanding(r, owners, members);
    if (by) return { rule: r.id, author: r.author, namedBy: by };
  }
  return null;
}

/** What the session is told of an agreement a decider rule made (policy input, said where it is used). */
export function deciderNote(
  writer: { key: string; label: string | null },
  act: SupportProposalKind,
  found: DeciderRuleFound,
): string {
  const who = found.namedBy === 'owner' ? 'the owner' : 'a confirmed team member';
  return `It counted as @${writer.label ?? writer.key}'s agreement: the channel rule ${found.author ? `@${found.author}` : who} (${who}) wrote names them the one who decides ${actsWords([act])}.`;
}

/** What the session is told of a rule's decider when it keeps the rule: whom it names, and whether it stands. */
export interface RuleDecider {
  member: string;
  acts: ChannelDecider['acts'];
  stands: boolean;
  /** What it does, or why it does nothing, in words for the session. */
  says: string;
}

/** The decider a kept rule names, read as the agreement rule reads it. */
export async function ruleDeciderOf(
  room: Pick<RoomRow, 'projectId' | 'rid'>,
  channelId: string,
  rule: RuleRow,
): Promise<RuleDecider | undefined> {
  const view = deciderView(
    rule,
    await channelOwners(room.projectId, room.rid),
    await membersOf(channelId),
  );
  if (!view) return undefined;
  const acts = actsWords(view.acts);
  return {
    member: view.member,
    acts: view.acts,
    stands: view.by !== null,
    says: view.by
      ? `@${view.member} now decides ${acts} in this group: their own request for it is their agreement, so cite it with agree at once and ask them nothing.`
      : `kept as a rule, but it names no decider: only a rule the owner or a member confirmed as ${CHANGE_CONFIRM_ROLES.map((r) => CHANNEL_ROLE_LABEL[r]).join(' or ')} writes makes one, so @${view.member}'s requests for ${acts} still wait for their plain yes after you ask.`,
  };
}
