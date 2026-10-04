import { skillActivityEvents } from '../db/schema.js';
import type { RecordSkillActivityEventInput, SkillActivityExecutor } from '../jobs/index.js';

export type { RecordSkillActivityEventInput, SkillActivityExecutor };

/** Append one row to the skill-update activity log (Update Pipeline §7 / §9.11). */
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
