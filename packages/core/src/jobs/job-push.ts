// The live push for a job's moves: one `job.changed` outbox event the WebSocket door turns into the
// room message, so every job writer pushes the same way and none imports the outbox itself.

import type { JobCancel, JobChange, JobFrameName } from '@forge/contracts/outbox-events';
import { sessionAudienceById } from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import type { EphemeralTarget } from '../lib/ephemeral.js';
import { emitEvent } from '../outbox/index.js';

interface JobRef {
  id: string;
  projectId: string;
  deviceId: string | null;
  agentSessionId: string | null;
}

/**
 * Who a job's frames are for: the session's audience when the job runs a person's own chat (its
 * owner and the project's admins, never the project room), the project room otherwise.
 */
export async function jobAudience(
  job: Pick<JobRef, 'agentSessionId'>,
): Promise<{ projectWide: boolean; userIds: string[] }> {
  if (!job.agentSessionId) return { projectWide: true, userIds: [] };
  return sessionAudienceById(job.agentSessionId);
}

/** `jobAudience` as the target an ephemeral frame (a live log line) is published to. */
export async function jobEphemeralTarget(
  job: Pick<JobRef, 'projectId' | 'agentSessionId'>,
): Promise<EphemeralTarget> {
  const audience = await jobAudience(job);
  return audience.projectWide ? { projectId: job.projectId } : { userIds: audience.userIds };
}

/** A job moved: its readers are told, with the project named so the project's run list refreshes. */
export async function pushJobChanged(
  job: JobRef,
  event: JobFrameName,
  data: JobChange,
): Promise<void> {
  const audience = await jobAudience(job);
  await emitEvent(db, 'job.changed', {
    projectId: job.projectId,
    jobId: job.id,
    deviceId: job.deviceId,
    event,
    data,
    ...audience,
  });
}

/** Ask the box running a job to stop it; told to that box's room only. */
export async function pushJobCancel(
  job: Pick<JobRef, 'id' | 'projectId'> & { deviceId: string },
  data: JobCancel,
): Promise<void> {
  await emitEvent(db, 'job.changed', {
    projectId: job.projectId,
    jobId: job.id,
    deviceId: job.deviceId,
    event: 'job.cancel',
    data,
  });
}
