/**
 * A request its value check refused (REQ-65 BC-2, BC-6; workflow requirement-lifecycle edges
 * draft -> refused, refused -> draft): the intake assistant's check moves a draft requirement to
 * `refused` with its one-line reason, as the kernel's own act, and a person who may write the project
 * keeps it with a one-line reason of their own, which moves it back to draft. Both reasons are the
 * reasons of their kernel moves; the check and the keep are kept on the item's intake draft.
 */

import { REQUIREMENT_MACHINE } from '@forge/contracts/requirement-machine';
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { requirements } from '../db/schema-requirements.js';
import { movedRow, transition } from '../lifecycle/index.js';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { type RequirementActor, rowIn } from './read.js';
import { lockRequirements, requirementKernelActor } from './write-tx.js';

/** Why a value-check move did not happen: the requirement no longer stands where the move starts. */
export type ValueMoveMissed = { moved: false; status: string };

/** Refuses a draft requirement on its value check's reason, in `tx`; a requirement that left draft meanwhile is not moved. */
export async function refuseOnValueIn(
  tx: Tx,
  input: { projectId: string; requirementId: string; reason: string },
): Promise<{ moved: true } | ValueMoveMissed> {
  await lockRequirements(tx, input.projectId);
  const row = await rowIn(tx, input.projectId, input.requirementId);
  if (row.status !== 'draft') return { moved: false, status: row.status };
  const moved = await transition(tx, REQUIREMENT_MACHINE, {
    to: 'refused',
    expect: 'draft',
    set: { updatedAt: new Date() },
    where: eq(requirements.id, row.id),
    reason: input.reason,
    actor: { type: 'system' },
    source: 'requirements',
    returning: ['id'],
  });
  movedRow(moved);
  return { moved: true };
}

/** A person keeps a refused requirement with a one-line reason, in `tx`: it is a draft again. */
export async function keepRefusedIn(
  tx: Tx,
  input: { projectId: string; requirementId: string; actor: RequirementActor; reason: string },
): Promise<{ moved: true } | ValueMoveMissed> {
  await requireCan(actorFor(input.actor.userId), 'project.write', projectResource(input.projectId));
  await lockRequirements(tx, input.projectId);
  const row = await rowIn(tx, input.projectId, input.requirementId);
  if (row.status !== 'refused') return { moved: false, status: row.status };
  const moved = await transition(tx, REQUIREMENT_MACHINE, {
    to: 'draft',
    expect: 'refused',
    set: { updatedAt: new Date() },
    where: eq(requirements.id, row.id),
    reason: input.reason,
    actor: requirementKernelActor(input.actor),
    source: 'requirements',
    returning: ['id'],
  });
  movedRow(moved);
  return { moved: true };
}
