// What the workflows module reads from the host a project's repository lives on: whether an observed
// commit is on the landing branch, and the cited files at that commit; and what a design decision or a
// superseding write does to the questions waiting on a revision (ISS-254). The composition root
// provides it at boot (`work-ports.ts`).

import type { ActorAgency } from '@forge/contracts/permissions';
import type { ChangedTrace, RequirementState } from '@forge/contracts/requirements';
import type { Tx } from '../db/client.js';
import { portSlot } from '../lib/port-slot.js';

export interface ObservedRepository {
  /** The landing branch an observed commit must be on. */
  branch: string;
  contains: (sha: string) => Promise<boolean>;
  readFile: (path: string, sha: string) => Promise<string | { missing: string }>;
}

interface WorkflowPorts {
  /** The project's repository, or why it cannot be read. */
  repositoryOf: (projectId: string) => Promise<ObservedRepository | { unreadable: string }>;
  /** The BCs an issue traces that a revision after its plan's changed (requirements, step `impact`). */
  changedTracedOf: (
    executor: Pick<Tx, 'execute'>,
    issueIds: readonly string[],
  ) => Promise<Map<string, ChangedTrace[]>>;
  /** Each requirement's state as its own standing reads it (requirements `standing.ts:stateOf`). */
  requirementStatesOf: (
    projectId: string,
    requirementIds: readonly string[],
  ) => Promise<Map<string, RequirementState>>;
  /** Answer the open questions waiting on a revision with its decision, in the decision's transaction. */
  answerDesignQuestions: (
    tx: Tx,
    args: {
      workflowId: string;
      revision: number;
      flow: string;
      decision: 'approve' | 'return';
      reason: string | null;
      by: string;
      agency: ActorAgency;
    },
  ) => Promise<string[]>;
  /** Void the questions waiting on a revision superseded undecided, and ask each issue of the new one. */
  reaskSupersededDesignQuestions: (
    tx: Tx,
    args: {
      workflowId: string;
      superseded: number;
      revision: number;
      flow: string;
      by: string;
      actor: { type: 'user'; id: string; agency: ActorAgency };
    },
  ) => Promise<void>;
}

const slot = portSlot<WorkflowPorts>('workflows', 'provideWorkflowPorts');
export const provideWorkflowPorts = slot.provide;
export const repositoryOf = slot.port('repositoryOf');
export const changedTracedOf = slot.port('changedTracedOf');
export const requirementStatesOf = slot.port('requirementStatesOf');
export const answerDesignQuestions = slot.port('answerDesignQuestions');
export const reaskSupersededDesignQuestions = slot.port('reaskSupersededDesignQuestions');
