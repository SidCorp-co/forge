// What the workflow health read model reads from other modules' read models: open feedback with its
// own waiting-on, and the latest run of each build issue as runs/standing reads it. The composition
// root provides them at boot (`work-ports.ts`).

import type { FeedbackSummary } from '@forge/contracts/feedback';
import type { ActorAgency } from '@forge/contracts/permissions';
import type { RunStanding } from '@forge/contracts/run-standing';
import { portSlot } from '../lib/port-slot.js';

export interface HealthViewer {
  userId: string;
  agency: ActorAgency;
}

interface WorkflowHealthPorts {
  /** Feedback of the project at phase new, triaged, planned or reopened. */
  openFeedbackOf: (viewer: HealthViewer, projectId: string) => Promise<FeedbackSummary[]>;
  /** The latest run of each issue, read as `GET runs/standing` reads it. */
  latestRunsOf: (
    viewer: HealthViewer,
    projectId: string,
    issueIds: readonly string[],
  ) => Promise<{ issueId: string; run: RunStanding }[]>;
}

const slot = portSlot<WorkflowHealthPorts>('workflows', 'provideWorkflowHealthPorts');
export const provideWorkflowHealthPorts = slot.provide;
export const openFeedbackOf = slot.port('openFeedbackOf');
export const latestRunsOf = slot.port('latestRunsOf');
