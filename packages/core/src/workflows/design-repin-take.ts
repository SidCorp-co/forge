/**
 * How the re-pin act (`design-repin-service.ts:repinAs`) takes each unit of its plan inside its one
 * transaction: a design written as the acting person's pin-only revision (or a filed one taken as it
 * stands) and approved, or a ring of designs naming each other as bases written whole, then approved
 * whole, its base check reading every member approved at the revision just written for it (FB-150).
 */

import type { Said } from '@forge/contracts/said';
import { sayEn } from '@forge/contracts/said';
import type { Tx } from '../db/client.js';
import { RefusalError } from '../lib/refusal.js';
import { type DesignRefusal, designFingerprint } from './design.js';
import { standingBaseRefusal } from './design-bases.js';
import { recordDecision } from './design-record.js';
import type { RepinStep } from './design-repin.js';
import { reaskSupersededDesignQuestions } from './ports.js';
import { readStoredWorkflow } from './schema.js';
import type { WorkflowWriter } from './service.js';
import {
  insertDesign,
  moveDesign,
  readWorkflow,
  replaceWorkflow,
  type StoredDesign,
  type StoredWorkflow,
  workflowsOf,
} from './store.js';

/** Refuses the whole act, rolling its transaction back: nothing it wrote stands. */
export const actRefused = (refusals: DesignRefusal[]) =>
  new RefusalError(refusals, 'WORKFLOW_REFUSED');

export interface StepInput {
  projectId: string;
  step: RepinStep;
  actor: WorkflowWriter;
  /** Forge's own sentence naming the act: stored in English beside the sentence it was said from. */
  reason: Said;
  pending?: StoredDesign;
}

interface Written {
  input: StepInput;
  revision: number;
  designIssueId: string | null;
  approving: unknown;
}

/** The step's pin-only revision written as the acting person's (or the filed one taken as it stands). */
async function writeStep(tx: Tx, input: StepInput): Promise<Written> {
  const { step, actor } = input;
  const reason = sayEn(input.reason);
  const d = step.design;
  const row = await readWorkflow(tx, d.id);
  if (!row || row.revision !== d.revision) {
    throw new Error(`workflows: ${d.flow} moved under the project's workflow lock`);
  }
  let revision = step.approves;
  let designIssueId = input.pending?.designIssueId ?? null;
  if (step.write) {
    const next = await replaceWorkflow(tx, {
      id: d.id,
      revision: row.revision,
      doc: step.write,
      userId: actor.userId,
      design: {
        designFingerprint: designFingerprint(step.write, d.template),
        approvedRevision: row.approvedRevision,
      },
    });
    revision = next.revision;
    // a ring member's pins name the revisions the plan fixed for the others, so this one must land there
    if (revision !== step.approves) {
      throw new Error(
        `workflows: ${d.flow} re-pin wrote revision ${revision}, the plan fixed ${step.approves}`,
      );
    }
    // a re-pin is drawn under no issue: the walk for the next proposal's issue passes over it
    designIssueId = null;
    if (row.designStatus !== 'proposed') {
      await moveDesign(tx, d.id, row.designStatus, 'proposed', { writer: actor, reason });
    }
    await insertDesign(tx, {
      workflowId: d.id,
      revision,
      document: step.write,
      userId: actor.userId,
      designIssueId: null,
    });
    if (row.designStatus === 'proposed' && input.pending) {
      await reaskSupersededDesignQuestions(tx, {
        workflowId: d.id,
        superseded: input.pending.revision,
        revision,
        flow: d.flow,
        by: actor.userId,
        actor: { type: 'user', id: actor.userId, agency: actor.agency },
      });
    }
  }
  const approving = step.write ?? readStoredWorkflow(input.pending?.document);
  return { input, revision, designIssueId, approving };
}

/** Every written step approved, once each passes the base check against `held`. */
async function approveWritten(
  tx: Tx,
  written: readonly Written[],
  held: readonly StoredWorkflow[],
): Promise<void> {
  for (const w of written) {
    const unapproved = standingBaseRefusal(w.revision, w.approving, held);
    if (unapproved) throw actRefused([{ ...unapproved, flow: w.input.step.design.flow }]);
  }
  for (const { input, revision, designIssueId } of written) {
    const d = input.step.design;
    await recordDecision(tx, {
      projectId: input.projectId,
      row: { id: d.id, flow: d.flow, designStatus: 'proposed' },
      designIssueId,
      revision,
      decision: 'approve',
      reason: sayEn(input.reason),
      reasonSays: input.reason,
      decider: input.actor,
    });
  }
}

/**
 * One unit of the plan: a design written and approved, or a ring written whole and then approved
 * whole, its base check reading every member approved at the revision just written for it.
 */
export async function takeUnit(
  tx: Tx,
  projectId: string,
  inputs: readonly StepInput[],
): Promise<number[]> {
  const written: Written[] = [];
  for (const input of inputs) written.push(await writeStep(tx, input));
  const ring = new Map(written.map((w) => [w.input.step.design.id, w.revision]));
  const held = (await workflowsOf(tx, projectId)).map((row) => {
    const at = inputs.length > 1 ? ring.get(row.id) : undefined;
    return at === undefined
      ? row
      : { ...row, designStatus: 'approved' as const, approvedRevision: at };
  });
  await approveWritten(tx, written, held);
  return written.map((w) => w.revision);
}

/** The plan's ready steps as the units the act takes: a ring's members together, the rest alone. */
export function unitsOf(ready: readonly RepinStep[]): RepinStep[][] {
  const units: RepinStep[][] = [];
  for (const step of ready) {
    const last = units.at(-1);
    const sameRing = last !== undefined && step.ring.length > 0 && last[0]?.ring === step.ring;
    if (sameRing) last.push(step);
    else units.push([step]);
  }
  return units;
}
