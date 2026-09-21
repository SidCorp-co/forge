import { isMetaSkillName } from './meta-skills.js';

export type LockedSkillsDeclaration = boolean | readonly string[] | undefined;

export type SkillLockReason = 'forge-reserved' | 'project-declared';

export interface SkillLockContext {
  /** `pipelineConfig.lockedSkills`. */
  declared?: LockedSkillsDeclaration;
}

export function skillLockReason(name: string, ctx: SkillLockContext): SkillLockReason | null {
  if (isMetaSkillName(name)) return 'forge-reserved';
  if (ctx.declared === true) return 'project-declared';
  if (Array.isArray(ctx.declared) && ctx.declared.includes(name)) return 'project-declared';
  return null;
}

export function isSkillLocked(name: string, ctx: SkillLockContext): boolean {
  return skillLockReason(name, ctx) !== null;
}

/** Thrown when a project tries to create, adopt or rename onto a locked name. */
export class SkillLockedError extends Error {
  readonly code = 'SKILL_LOCKED';
  constructor(
    readonly skillName: string,
    readonly reason: SkillLockReason,
  ) {
    super(`SKILL_LOCKED: '${skillName}' is locked (${reason}) and cannot be overridden`);
    this.name = 'SkillLockedError';
  }
}

export function readLockedSkills(pipelineConfig: unknown): LockedSkillsDeclaration {
  if (typeof pipelineConfig !== 'object' || pipelineConfig === null) return undefined;
  const value = (pipelineConfig as Record<string, unknown>).lockedSkills;
  if (value === true) return true;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}
