// What reached a run (ISS-1065), composed at the root (ADR 0008): run-context sits in Knowledge and
// cannot import the execution modules that know which run a call was made in, and the execution
// kernels that compose a run's prompt or open a declared run cannot import run-context. Each is
// handed what it needs here, from the owners' faces.

import { declaredRunOfCall } from './devices/index.js';
import { resolvePipelineContext } from './jobs/index.js';
import { orientationCarried } from './prompt/index.js';
import {
  type CallRun,
  provideRunContextPorts,
  type RunCaller,
  recordCarriedLater,
} from './run-context/index.js';

/** The issues a declared run session works, read from its declaration; none for any other session. */
async function declaredIssuesOf(run: {
  deviceId: string;
  projectId: string;
  sessionId: string;
}): Promise<readonly string[]> {
  const declared = await declaredRunOfCall(
    { deviceId: run.deviceId, boundProjectId: run.projectId, projectIds: null },
    run.sessionId,
  );
  return declared.kind === 'run' ? declared.issueIds : [];
}

/**
 * The one run a box credential's read was made in. A run the call names (`x-forge-run`) must be one
 * declared on that box in the read's project; a call naming none is the box's one live session in
 * the project, and a box running several names none, since a guess would put one run's reads on
 * another's record.
 */
async function runOfCall(caller: RunCaller): Promise<CallRun> {
  if (caller.asked) {
    const fence = caller.fence && caller.fence.length > 0 ? caller.fence : null;
    const declared = await declaredRunOfCall(
      {
        deviceId: caller.deviceId,
        boundProjectId: fence?.length === 1 ? (fence[0] ?? null) : null,
        projectIds: fence,
      },
      caller.asked,
    );
    if (declared.kind === 'refused') return { ok: false, reason: declared.detail };
    if (declared.kind === 'none' || declared.projectId !== caller.projectId) {
      return {
        ok: false,
        reason: `${caller.asked} names no run declared on this box in project ${caller.projectId}`,
      };
    }
    return { ok: true, sessionId: declared.sessionId, issueIds: declared.issueIds };
  }
  const own = await resolvePipelineContext({
    deviceId: caller.deviceId,
    boundProjectId: caller.projectId,
  });
  if (!own.ok) return { ok: false, reason: own.detail };
  const { agentSessionId, issueId } = own.context;
  const issueIds = issueId
    ? [issueId]
    : await declaredIssuesOf({
        deviceId: caller.deviceId,
        projectId: caller.projectId,
        sessionId: agentSessionId,
      });
  return { ok: true, sessionId: agentSessionId, issueIds };
}

/** Records the rules and lessons a declared run's checkout orientation carries, as it opens. */
export function recordOrientationCarried(run: {
  projectId: string;
  deviceId: string;
  sessionId: string;
}): void {
  recordCarriedLater(run, async () => ({
    sources: await orientationCarried(run.projectId),
    issueIds: await declaredIssuesOf(run),
  }));
}

export function provideRunContextDomainPorts(): void {
  provideRunContextPorts({ runOfCall });
}
