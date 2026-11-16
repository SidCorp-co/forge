// The one call a read route makes to record what it returned (ISS-1065). Only a credential tied to a
// box reads in a run: the box's own (a master's, a run's) or a session's turn token (a room's agent,
// ISS-1251); a person's session or personal token reaches no run, so its reads record nothing. A find
// hit opened is the exception (ISS-1256): whoever opens it, the open is a read the module map counts.

import { RUN_CONTEXT_RUN_HEADER, type RunContextHow } from '@forge/contracts/run-context';
import type { Context } from 'hono';
import { fencedProjectIds } from '../credentials/pat-scope.js';
import type { AuthVars } from '../middleware/auth.js';
import { failed, recordCalled, recordOpened } from './record.js';
import { type Found, sourcesOf } from './sources.js';

/** The box credential this request read with, and the run it names; null for a person's. */
function callerOf(c: Context<{ Variables: AuthVars }>, projectId: string) {
  const deviceId = c.get('patDeviceId') ?? c.get('deviceId') ?? null;
  if (!deviceId) return null;
  const asked = c.req.header(RUN_CONTEXT_RUN_HEADER)?.trim() || null;
  const tokenId = c.get('patTokenId') ?? null;
  return { deviceId, fence: fencedProjectIds(), projectId, asked, tokenId };
}

/**
 * Records `found`, what this request's read of `projectId` returned, against the run its box
 * credential reads in. Returns at once: the write runs after the response, and a failure is counted,
 * never the read's.
 */
export function recordReached(
  c: Context<{ Variables: AuthVars }>,
  projectId: string,
  how: Exclude<RunContextHow, 'prompt'>,
  found: Found,
): void {
  try {
    const caller = callerOf(c, projectId);
    if (caller) recordCalled(caller, how, sourcesOf(found));
  } catch (err) {
    failed({ projectId, deviceId: c.get('patDeviceId') ?? c.get('deviceId') ?? null, how })(err);
  }
}

/**
 * Records a find hit this request opened in `projectId` (ISS-1256): against the run a box credential
 * names, else as an open outside any run, by the account that read. Returns at once.
 */
export function recordFindOpened(
  c: Context<{ Variables: AuthVars }>,
  projectId: string,
  found: Found,
): void {
  try {
    recordOpened(
      { projectId, userId: c.get('userId'), caller: callerOf(c, projectId) },
      sourcesOf(found),
    );
  } catch (err) {
    failed({ projectId, how: 'find-open' })(err);
  }
}
