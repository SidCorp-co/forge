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

/** Append one row to the skill-update activity log (Update Pipeline §7 / §9.11). */
// cm:guard Call ONLY inside the same db.transaction as the state change it describes (pass `tx`, never bare `db`) — no swallow-errors wrapper exists on purpose, per invariant §9.11.
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
