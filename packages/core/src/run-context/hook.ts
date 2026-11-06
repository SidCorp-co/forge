// The one call a read route makes to record what it returned (ISS-1065). Only a box's credential
// reads in a run: a person's session or personal token reaches no run, so its reads record nothing.

import { RUN_CONTEXT_RUN_HEADER, type RunContextHow } from '@forge/contracts/run-context';
import type { Context } from 'hono';
import { fencedProjectIds } from '../credentials/pat-scope.js';
import type { AuthVars } from '../middleware/auth.js';
import { failed, recordCalled } from './record.js';
import { type Found, sourcesOf } from './sources.js';

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
  const deviceId = c.get('patDeviceId') ?? c.get('deviceId') ?? null;
  if (!deviceId) return;
  try {
    const sources = sourcesOf(found);
    const asked = c.req.header(RUN_CONTEXT_RUN_HEADER)?.trim() || null;
    recordCalled({ deviceId, fence: fencedProjectIds(), projectId, asked }, how, sources);
  } catch (err) {
    failed({ projectId, deviceId, how })(err);
  }
}
