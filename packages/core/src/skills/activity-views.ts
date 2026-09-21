import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type SkillActivityEventType, skillActivityEvents } from '../db/schema.js';

const eventColumns = {
  id: skillActivityEvents.id,
  occurredAt: skillActivityEvents.occurredAt,
  packetId: skillActivityEvents.packetId,
  projectId: skillActivityEvents.projectId,
  skillId: skillActivityEvents.skillId,
  deviceId: skillActivityEvents.deviceId,
  eventType: skillActivityEvents.eventType,
  actor: skillActivityEvents.actor,
  trigger: skillActivityEvents.trigger,
  beforeHash: skillActivityEvents.beforeHash,
  afterHash: skillActivityEvents.afterHash,
  deltaSummary: skillActivityEvents.deltaSummary,
  reason: skillActivityEvents.reason,
  outcome: skillActivityEvents.outcome,
} as const;

export type SkillActivityEventRowShape = {
  id: string;
  occurredAt: Date;
  packetId: string | null;
  projectId: string | null;
  skillId: string | null;
  deviceId: string | null;
  eventType: SkillActivityEventType;
  actor: string;
  trigger: string;
  beforeHash: string | null;
  afterHash: string | null;
  deltaSummary: string | null;
  reason: string | null;
  outcome: string;
};

/** A bounded page of the activity log, and whether the bound cut it. */
export interface SkillActivityPage {
  events: SkillActivityEventRowShape[];
  truncated: boolean;
}

/**
 * The one bounded read behind all three views: the most recent `limit` events
 * matching `where`, handed back oldest-first.
 */
async function readBounded(
  where: ReturnType<typeof and>,
  limit: number,
): Promise<SkillActivityPage> {
  const rows = (await db
    .select(eventColumns)
    .from(skillActivityEvents)
    .where(where)
    .orderBy(desc(skillActivityEvents.occurredAt), desc(skillActivityEvents.id))
    .limit(limit + 1)) as SkillActivityEventRowShape[];
  const truncated = rows.length > limit;
  const page = truncated ? rows.slice(0, limit) : rows;
  return { events: page.reverse(), truncated };
}

/** By-skill view: content timeline for one project, optionally narrowed to one skill. */
export async function listBySkill(input: {
  projectId: string;
  skillId?: string;
  limit: number;
}): Promise<SkillActivityPage> {
  return readBounded(
    and(
      eq(skillActivityEvents.projectId, input.projectId),
      input.skillId ? eq(skillActivityEvents.skillId, input.skillId) : undefined,
    ),
    input.limit,
  );
}

/** By-device view: what a device received, in what order, observed vs shadowed. */
export async function listByDevice(input: {
  projectId: string;
  deviceId: string;
  limit: number;
}): Promise<SkillActivityPage> {
  return readBounded(
    and(
      eq(skillActivityEvents.projectId, input.projectId),
      eq(skillActivityEvents.deviceId, input.deviceId),
    ),
    input.limit,
  );
}

/** By-packet view: the operational rollup across all five stages for one update. */
export async function listByPacket(packetId: string, limit: number): Promise<SkillActivityPage> {
  return readBounded(eq(skillActivityEvents.packetId, packetId), limit);
}

/**
 * Per-event-type counts for a whole packet — the "N no-op / M changed / K
 * escalated" rollup line.
 */
export async function summarizeByEventType(packetId: string): Promise<Record<string, number>> {
  const rows = await db
    .select({
      eventType: skillActivityEvents.eventType,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(skillActivityEvents)
    .where(eq(skillActivityEvents.packetId, packetId))
    .groupBy(skillActivityEvents.eventType);
  const summary: Record<string, number> = {};
  for (const row of rows) summary[row.eventType] = row.count;
  return summary;
}
