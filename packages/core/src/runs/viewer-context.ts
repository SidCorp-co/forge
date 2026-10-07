// What a run standing read knows about its viewer and the box: the viewer's grants, liveness and the masters.

import { RUN_STUCK_AFTER_MS } from '@forge/contracts/run-standing';
import { SESSION_SILENCE_TIMEOUT_MS } from '../devices/index.js';
import {
  gateReasonsForQueuedJobsIn,
  getLoopThresholds,
  killGraceMs,
  RESULT_QUIET_MINUTES,
} from '../jobs/index.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { peopleOf } from '../lib/people.js';
import { readMasterStanding } from '../masters/read.js';
import { holderNames, holds } from '../permissions/index.js';
import type { StandingContext } from './standing.js';
import { RUN_NEED_PERMISSION } from './standing-types.js';

export interface RunViewer {
  userId: string;
}

async function viewerOf(viewer: RunViewer | null, projectId: string) {
  if (!viewer) return null;
  const [access, people] = await Promise.all([
    effectiveProjectRole(viewer.userId, projectId),
    peopleOf([viewer.userId]),
  ]);
  // A person's wait addresses its viewer as "You" only when the viewer is a person.
  const person = people.get(viewer.userId)?.kind !== 'agent';
  return {
    canWrite: person && access !== null && holds(access, 'project.write'),
    isAdmin: person && access !== null && holds(access, 'project.admin'),
    mayApprove: access !== null && holds(access, 'releases.approve'),
  };
}

export async function contextFor(projectId: string, viewer: RunViewer | null) {
  const [master, who, queuedGates, write, admin, approve] = await Promise.all([
    readMasterStanding(projectId),
    viewerOf(viewer, projectId),
    gateReasonsForQueuedJobsIn([projectId]),
    holderNames(RUN_NEED_PERMISSION.write, projectId),
    holderNames(RUN_NEED_PERMISSION.admin, projectId),
    holderNames(RUN_NEED_PERMISSION.approve, projectId),
  ]);
  const slots =
    master.slots && master.slots.max !== null
      ? { inUse: master.slots.inUse, max: master.slots.max }
      : null;
  const ctx: StandingContext = {
    now: new Date(),
    viewer: who,
    holders: { write, admin, approve },
    slots,
    stuckAfterMs: RUN_STUCK_AFTER_MS,
    queuedGates,
    silenceReapMs: SESSION_SILENCE_TIMEOUT_MS,
    jobHeartbeatMs: getLoopThresholds().heartbeatMs,
    jobAckMs: getLoopThresholds().ackMs,
    jobQueueMs: getLoopThresholds().queueMs,
    resultQuietMs: RESULT_QUIET_MINUTES * 60_000,
    killGraceMs: killGraceMs(),
  };
  return { master, ctx };
}
