// Which skills a project may not override (agent-driven pipeline, phase 1a).
//
// Being non-overridable used to be a side effect of DELIVERY: a skill was safe
// from shadowing because it shipped on the device-scope plugin channel. That is
// backwards — it made "protect this skill" mean "move it to another repo", and
// it left every disk-delivered skill unprotectable. Claude Code separates the
// two: managed settings lock a surface, independently of where its content came
// from.
//
// So the lock is a declaration. `META_SKILL_NAMES` goes back to meaning only
// what its name says — Forge owns this name — and locking is decided here.
//
// Design: docs/proposals/agent-driven-pipeline.md

import { isMetaSkillName } from './meta-skills.js';

/**
 * A project's declaration, read from `pipelineConfig.lockedSkills`. `true`
 * locks the whole surface; an array locks those names. Mirrors the shape of
 * Claude Code's managed-settings surface lock so the two read the same way.
 */
export type LockedSkillsDeclaration = boolean | readonly string[] | undefined;

export type SkillLockReason = 'forge-reserved' | 'project-declared';

export interface SkillLockContext {
  /** `pipelineConfig.lockedSkills`. */
  declared?: LockedSkillsDeclaration;
}

/**
 * Why this name is locked, or `null` if it is not.
 *
 * Reasons compose by UNION and are evaluated most-authoritative first, so the
 * caller can report which rule bit.
 */
// cm:guard locks only ever ADD — a project declaration can never unlock a Forge-reserved name, or `lockedSkills: []` would become a way to shadow forge-reconcile, the agent that polices the project's own updates
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

/**
 * Read the declaration out of an untyped `pipelineConfig`. Anything that is not
 * `true` or an array of strings is treated as absent rather than coerced: a
 * malformed lock that silently means "locked" would block every skill write on
 * the project, and one that silently means "unlocked" is worse.
 */
export function readLockedSkills(pipelineConfig: unknown): LockedSkillsDeclaration {
  if (typeof pipelineConfig !== 'object' || pipelineConfig === null) return undefined;
  const value = (pipelineConfig as Record<string, unknown>)['lockedSkills'];
  if (value === true) return true;
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return undefined;
}
