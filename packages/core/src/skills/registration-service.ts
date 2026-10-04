/**
 * Which skill serves which pipeline stage — registration, distinct from the
 * skill CRUD in `service.ts`. Split out when that file crossed its line budget
 * (ISS-894 wave 3); the seam is the concern, not the size.
 */

import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type IssueStatus, skillRegistrations, skills } from '../db/schema.js';
import { emitEvent } from '../outbox/index.js';
import { recordSkillActivityEvent } from './activity.js';
import { refuse } from './refuse.js';

export interface RegisterSkillInput {
  projectId: string;
  skillId: string;
  stage: IssueStatus | null;
  actorUserId: string;
}

export interface RegisterSkillResult {
  projectId: string;
  skillId: string;
  stage: IssueStatus | null;
}

export async function registerSkillForProject(
  input: RegisterSkillInput,
): Promise<RegisterSkillResult> {
  const { projectId, skillId, stage, actorUserId } = input;

  if (stage === null) {
    const [reg] = await db
      .select({ stage: skillRegistrations.stage })
      .from(skillRegistrations)
      .where(
        and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
      )
      .limit(1);

    await db.transaction(async (tx) => {
      await tx
        .delete(skillRegistrations)
        .where(
          and(eq(skillRegistrations.projectId, projectId), eq(skillRegistrations.skillId, skillId)),
        );
      if (reg) {
        await recordSkillActivityEvent(tx, {
          eventType: 'manifest.changed',
          actor: `human:${actorUserId}`,
          trigger: 'manual',
          projectId,
          skillId,
          deltaSummary: `unregistered from ${reg.stage}`,
        });
      }
      await emitEvent(tx, 'skill.registered', { projectId, skillId, actorUserId, stage: null });
    });
    return { projectId, skillId, stage: null };
  }

  const [target] = await db
    .select({ scope: skills.scope, projectId: skills.projectId })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1);
  if (target?.scope !== 'project' || target.projectId !== projectId) {
    throw refuse(
      'SKILL_NOT_PROJECT_SCOPED',
      `skill '${skillId}' is not a project skill for this project; adopt the global template into the project before registering it`,
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(skillRegistrations)
      .values({ projectId, skillId, stage, registeredBy: actorUserId })
      .onConflictDoUpdate({
        target: [skillRegistrations.projectId, skillRegistrations.stage],
        set: { skillId, registeredBy: actorUserId },
      });
    await tx
      .delete(skillRegistrations)
      .where(
        and(
          eq(skillRegistrations.projectId, projectId),
          eq(skillRegistrations.skillId, skillId),
          ne(skillRegistrations.stage, stage),
        ),
      );
    await recordSkillActivityEvent(tx, {
      eventType: 'manifest.changed',
      actor: `human:${actorUserId}`,
      trigger: 'manual',
      projectId,
      skillId,
      deltaSummary: `registered at stage ${stage}`,
    });
    await emitEvent(tx, 'skill.registered', { projectId, skillId, actorUserId, stage });
  });

  return { projectId, skillId, stage };
}
