// An item's state as the chat reports it after an act (REQ-41 BC-24, BC-27): its status read now, and
// who made its last move and when, from the kernel's own record of moves, so "ISS-603 is open, opened
// by the owner at 07:48" is a read and never the state the act was meant to leave.

import type { ChatItemState } from '@forge/contracts/chat-decide';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, kernelTransitions } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { resolveIssueKeyInProject } from '../issues/index.js';
import { userNames } from '../lib/people.js';

/** The kinds of item whose state is read: the ones a Needs-you decision opens and a move is kept for. */
export type ItemKind = 'issue' | 'requirement' | 'feedback';

const SEQ = { requirement: /^REQ-(\d+)$/i, feedback: /^FB-(\d+)$/i } as const;

/** The item's id and status in the project, or null where the key names none. */
async function rowOf(
  projectId: string,
  kind: ItemKind,
  key: string,
): Promise<{ id: string; status: string } | null> {
  if (kind === 'issue') {
    let id: string;
    try {
      id = await resolveIssueKeyInProject(key, projectId);
    } catch {
      return null;
    }
    const [row] = await db
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(and(eq(issues.id, id), eq(issues.projectId, projectId)))
      .limit(1);
    return row ?? null;
  }
  const seq = Number(SEQ[kind].exec(key)?.[1] ?? Number.NaN);
  if (!Number.isInteger(seq)) return null;
  const table = kind === 'requirement' ? requirements : feedback;
  const seqColumn = kind === 'requirement' ? requirements.reqSeq : feedback.fbSeq;
  const [row] = await db
    .select({ id: table.id, status: table.status })
    .from(table)
    .where(and(eq(table.projectId, projectId), eq(seqColumn, seq)))
    .limit(1);
  return row ?? null;
}

/** The kind of item a key names, by its form; an issue key is any other `PREFIX-n`. */
export function itemKindOf(key: string): ItemKind | null {
  if (SEQ.requirement.test(key)) return 'requirement';
  if (SEQ.feedback.test(key)) return 'feedback';
  return /^[A-Z][A-Z0-9]*-\d+$/i.test(key) ? 'issue' : null;
}

/** An item read back, or null where its key names nothing in the project. */
export type ChatItemStateRead = ChatItemState | null;

/** The item's status now, and its last recorded move's mover and time; null where the key names nothing. */
export async function itemStateOf(
  projectId: string,
  item: { kind: ItemKind; key: string },
): Promise<ChatItemState | null> {
  const row = await rowOf(projectId, item.kind, item.key);
  if (!row) return null;
  const [move] = await db
    .select({ actorId: kernelTransitions.actorId, at: kernelTransitions.createdAt })
    .from(kernelTransitions)
    .where(and(eq(kernelTransitions.entity, item.kind), eq(kernelTransitions.entityId, row.id)))
    .orderBy(desc(kernelTransitions.createdAt))
    .limit(1);
  const names = await userNames([move?.actorId ?? null]);
  return {
    key: item.key.toUpperCase(),
    status: row.status,
    movedBy: move?.actorId ? (names.get(move.actorId) ?? null) : null,
    movedAt: move?.at ? move.at.toISOString() : null,
  };
}

/** "ISS-603 is open; last moved by Darrel at 2026-10-22 07:48 UTC.", as read, never as meant. */
export function stateSentence(state: ChatItemState): string {
  const at = state.movedAt ? `${state.movedAt.slice(0, 16).replace('T', ' ')} UTC` : null;
  const moved =
    state.movedBy && at
      ? `; last moved by ${state.movedBy} at ${at}`
      : at
        ? `; last moved at ${at}`
        : '';
  return `${state.key} is ${state.status.replace(/_/g, ' ')}${moved}.`;
}
