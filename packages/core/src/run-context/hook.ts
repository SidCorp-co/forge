// The one call a read route makes to record what it returned (ISS-1065). Only a credential tied to a
// box reads in a run: the box's own (a master's, a run's) or a session's turn token (a room's agent,
// ISS-1251); a person's session or personal token reaches no run, so its reads record nothing.

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
    const tokenId = c.get('patTokenId') ?? null;
    recordCalled({ deviceId, fence: fencedProjectIds(), projectId, asked, tokenId }, how, sources);
  } catch (err) {
    failed({ projectId, deviceId, how })(err);
  }
}
