import { and, eq } from 'drizzle-orm';
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

/** By-skill view: content timeline for one project, optionally narrowed to one skill. */
export async function listBySkill(input: {
  projectId: string;
  skillId?: string;
}): Promise<SkillActivityEventRowShape[]> {
  return db
    .select(eventColumns)
    .from(skillActivityEvents)
    .where(
      and(
        eq(skillActivityEvents.projectId, input.projectId),
        input.skillId ? eq(skillActivityEvents.skillId, input.skillId) : undefined,
      ),
    )
    .orderBy(skillActivityEvents.occurredAt, skillActivityEvents.id);
}

/** By-device view: what a device received, in what order, observed vs shadowed. */
export async function listByDevice(input: {
  projectId: string;
  deviceId: string;
}): Promise<SkillActivityEventRowShape[]> {
  return db
    .select(eventColumns)
    .from(skillActivityEvents)
    .where(
      and(
        eq(skillActivityEvents.projectId, input.projectId),
        eq(skillActivityEvents.deviceId, input.deviceId),
      ),
    )
    .orderBy(skillActivityEvents.occurredAt, skillActivityEvents.id);
}

/** By-packet view: the operational rollup across all five stages for one update. */
export async function listByPacket(packetId: string): Promise<SkillActivityEventRowShape[]> {
  return db
    .select(eventColumns)
    .from(skillActivityEvents)
    .where(eq(skillActivityEvents.packetId, packetId))
    .orderBy(skillActivityEvents.occurredAt, skillActivityEvents.id);
}

/** Per-event-type counts — the "N no-op / M changed / K escalated" rollup line. */
export function summarizeByEventType(events: SkillActivityEventRowShape[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const event of events) {
    summary[event.eventType] = (summary[event.eventType] ?? 0) + 1;
  }
  return summary;
}
