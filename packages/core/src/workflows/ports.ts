// What the workflows module reads from the host a project's repository lives on: whether an observed
// commit is on the landing branch, and the cited files at that commit. The composition root provides
// it at boot (`work-ports.ts`).

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
}

const slot = portSlot<WorkflowPorts>('workflows', 'provideWorkflowPorts');
export const provideWorkflowPorts = slot.provide;
export const repositoryOf = slot.port('repositoryOf');
