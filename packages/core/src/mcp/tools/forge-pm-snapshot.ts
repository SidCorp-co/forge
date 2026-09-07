/**
 * `forge_pm.snapshot` (Epic 3, ISS-19) — the MCP face of
 * `pm/snapshot-service.ts`, which owns the digest itself.
 *
 * ISS-145: handler body extracted into `pmSnapshotHandler` and consumed by
 * both the legacy shim factory below and the consolidated
 * `forge_project_pm` dispatcher.
 */

import { z } from 'zod';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { readPmSnapshot } from '../../pm/snapshot-service.js';
import { assertPrincipalIsMember } from './lib.js';

export const pmSnapshotInputSchema = z.object({ projectId: z.uuid() }).strict();

export async function pmSnapshotHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pmSnapshotInputSchema>,
) {
  await assertPrincipalIsMember(principal, input.projectId);
  return readPmSnapshot(input.projectId);
}
