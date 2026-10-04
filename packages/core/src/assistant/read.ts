import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { chatLogs, projects, users } from '../db/schema.js';
import { conversationPins, conversationParticipants, conversations } from '../db/schema-conversations.js';
import { assistantSpeakerLinks } from '../db/schema-speaker-links.js';
import { isActiveMember } from '../ecosystem/store.js';

export const TOOL_CALL_TURNS = 200;

export interface RoomToolCall {
  turnId: string;
  at: string;
  name: string;
  arguments: string;
  round: number;
  isError: boolean;
  durationMs: number | null;
  resultPreview: string | null;
  resultIssueRefs: string[];
  ranAsRecorded: boolean;
  ranAs: string | null;
  refusalCode: string | null;
}

interface AuditRow {
  id: string;
  createdAt: Date;
  toolCalls: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** The tool calls in a room's audit rows, as the reader may see them: another speaker's result is withheld. */
export function roomToolCalls(rows: readonly AuditRow[], readerId: string): RoomToolCall[] {
  const out: RoomToolCall[] = [];
  for (const row of rows) {
    if (!Array.isArray(row.toolCalls)) continue;
    for (const raw of row.toolCalls) {
      if (!raw || typeof raw !== 'object') continue;
      const call = raw as Record<string, unknown>;
      const name = str(call.name);
      if (!name) continue;
      const ranAsRecorded = 'ranAs' in call;
      const ranAs = ranAsRecorded ? str(call.ranAs) : null;
      const own = ranAsRecorded && (ranAs === null || ranAs === readerId);
      out.push({
        turnId: row.id,
        at: row.createdAt.toISOString(),
        name,
        arguments: str(call.arguments) ?? '',
        round: typeof call.round === 'number' ? call.round : 1,
        isError: call.isError === true,
        durationMs: typeof call.durationMs === 'number' ? call.durationMs : null,
        resultPreview: own ? str(call.resultPreview) : null,
        resultIssueRefs: Array.isArray(call.resultIssueRefs)
          ? call.resultIssueRefs.filter((r): r is string => typeof r === 'string')
          : [],
        ranAsRecorded,
        ranAs,
        refusalCode: str(call.refusalCode),
      });
    }
  }
  return out;
}

/**
 * A room's tool calls from its last `TOOL_CALL_TURNS` audit rows, oldest first. The audit row
 * (`chat_logs.tool_calls`) is the only place a call's `ranAs` lives, so this reads it there.
 */
export async function readRoomToolCalls(
  conversationId: string,
  readerId: string,
  dbi = db,
): Promise<RoomToolCall[]> {
  const rows = await dbi
    .select({ id: chatLogs.id, createdAt: chatLogs.createdAt, toolCalls: chatLogs.toolCalls })
    .from(chatLogs)
    .where(eq(chatLogs.sessionId, conversationId))
    .orderBy(desc(chatLogs.createdAt))
    .limit(TOOL_CALL_TURNS);
  return roomToolCalls(rows.reverse(), readerId);
}

/** Whether the home project is an active member of the ecosystem. */
export async function homeIsEcosystemMember(
  homeProjectId: string,
  ecosystemId: string,
): Promise<boolean> {
  return isActiveMember(db, homeProjectId, ecosystemId);
}

/** Which of `ids` the user has pinned. */
export async function pinnedBy(userId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: conversationPins.conversationId })
    .from(conversationPins)
    .where(
      and(eq(conversationPins.userId, userId), inArray(conversationPins.conversationId, [...ids])),
    );
  return new Set(rows.map((r) => r.id));
}

/** The caller's live web room about one requirement, the most recently active, or null. */
export async function requirementRoomOf(
  requirementId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      and(
        eq(conversationParticipants.conversationId, conversations.id),
        eq(conversationParticipants.kind, 'person'),
        eq(conversationParticipants.userId, userId),
        isNull(conversationParticipants.removedAt),
      ),
    )
    .where(
      and(
        eq(conversations.requirementId, requirementId),
        eq(conversations.adapter, 'web'),
        isNull(conversations.archivedAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(1);
  return row?.id ?? null;
}

/** The name a person speaks under in a room: their display name, else their email. */
export async function speakerLabelOf(userId: string): Promise<string | null> {
  const [me] = await db
    .select({ displayName: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return me?.displayName ?? me?.email ?? null;
}

/** The project fields the weekly reading runs on, or null. */
export async function weeklyProjectOf(projectId: string) {
  const [row] = await db
    .select({ id: projects.id, slug: projects.slug, agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row ?? null;
}

/** A person's speaker links, newest first. */
export async function listSpeakerLinks(userId: string) {
  return db
    .select()
    .from(assistantSpeakerLinks)
    .where(eq(assistantSpeakerLinks.userId, userId))
    .orderBy(desc(assistantSpeakerLinks.confirmedAt));
}
