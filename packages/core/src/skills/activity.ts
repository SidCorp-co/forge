import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import {
  type SkillActivityEventType,
  type SkillActivityOutcome,
  type SkillActivityTrigger,
  skillActivityEvents,
} from '../db/schema.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A drizzle executor: the base `db` or a transaction handle. */
export type SkillActivityExecutor = Db | Tx;

export interface RecordSkillActivityEventInput {
  eventType: SkillActivityEventType;
  /** `human:<user>` | `agent:master` | `system:seeder` | `runner:<device>`. */
  actor: string;
  trigger: SkillActivityTrigger;
  packetId?: string;
  projectId?: string;
  skillId?: string;
  deviceId?: string;
  beforeHash?: string;
  afterHash?: string;
  deltaSummary?: string;
  reason?: string;
  outcome?: SkillActivityOutcome;
}

/**
 * Best-effort lookup of the `skill.body.changed` packet that produced `hash`
 * for `skillId` — lets device.skill.* / job.ran.with events stamp `packetId`
 * without the report/ack protocol carrying one explicitly (ISS-798 review
 * BLOCKER B). Returns `undefined` (never a lie) when the hash never
 * originated from a tracked packet — e.g. a user-authored shadow body.
 */
export async function resolvePacketIdForHash(
  executor: SkillActivityExecutor,
  projectId: string,
  skillId: string,
  hash: string,
): Promise<string | undefined> {
  const [row] = await executor
    .select({ packetId: skillActivityEvents.packetId })
    .from(skillActivityEvents)
    .where(
      and(
        eq(skillActivityEvents.projectId, projectId),
        eq(skillActivityEvents.skillId, skillId),
        eq(skillActivityEvents.eventType, 'skill.body.changed'),
        eq(skillActivityEvents.afterHash, hash),
      ),
    )
    .orderBy(desc(skillActivityEvents.occurredAt))
    .limit(1);
  return row?.packetId ?? undefined;
}

/** Append one row to the skill-update activity log (Update Pipeline §7 / §9.11). */
// cm:guard pass `tx` (never bare `db`) when the event accompanies a state change, so it commits atomically with it (§9.11); a pre-run refusal that changes no state may pass bare `db`, but the caller must then tolerate this write itself failing — no swallow-errors wrapper exists on purpose.
export async function recordSkillActivityEvent(
  executor: SkillActivityExecutor,
  input: RecordSkillActivityEventInput,
): Promise<void> {
  await executor.insert(skillActivityEvents).values({
    eventType: input.eventType,
    actor: input.actor,
    trigger: input.trigger,
    packetId: input.packetId ?? null,
    projectId: input.projectId ?? null,
    skillId: input.skillId ?? null,
    deviceId: input.deviceId ?? null,
    beforeHash: input.beforeHash ?? null,
    afterHash: input.afterHash ?? null,
    deltaSummary: input.deltaSummary ?? null,
    reason: input.reason ?? null,
    outcome: input.outcome ?? 'ok',
  });
}
