// What a steward run looks like on its item (REQ-48 BC-1, BC-12): `GET /api/projects/:id/steward-runs`
// answers an item's runs, newest first, each with the acts it took through which doors.

import type { StewardRunView } from '@forge/contracts/steward';
import type { StewardActsResponse, StewardRunsResponse } from '@forge/contracts/steward-runtime';
import { actorFor, projectResource, requireCan } from '../permissions/index.js';
import { actsOfRuns, actsOfSubject } from './acts-store.js';
import { type RunRow, runsOfSubject } from './runs-store.js';

export function runViewOf(run: RunRow, acts: StewardRunView['acts']): StewardRunView {
  return {
    id: run.id,
    subject: { kind: run.subjectKind, id: run.subjectId, key: run.subjectKey },
    trigger: run.trigger,
    events: run.events,
    actsToRun: run.actsToRun,
    followUp: run.followUp,
    basis: run.basis ?? '',
    state: run.state,
    skipReason: run.skipReason ?? null,
    failure: run.failure,
    jobId: run.jobId,
    turnId: run.turnId,
    queuedAt: run.queuedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    endedAt: run.endedAt?.toISOString() ?? null,
    acts,
  };
}

/** The item's runs as `userId` may read them: a project reader reads every one. */
export async function readStewardRuns(args: {
  projectId: string;
  userId: string;
  subjectKey: string;
}): Promise<StewardRunsResponse> {
  await requireCan(actorFor(args.userId), 'project.read', projectResource(args.projectId));
  const runs = await runsOfSubject(args.projectId, args.subjectKey);
  const acts = await actsOfRuns(runs.map((r) => r.id));
  return { runs: runs.map((r) => runViewOf(r, acts.get(r.id) ?? [])) };
}

/** Every act the steward took on the item, as `userId` may read it: a project reader reads every one. */
export async function readStewardActs(args: {
  projectId: string;
  userId: string;
  subjectKey: string;
}): Promise<StewardActsResponse> {
  await requireCan(actorFor(args.userId), 'project.read', projectResource(args.projectId));
  return { acts: await actsOfSubject(args.projectId, args.subjectKey) };
}
