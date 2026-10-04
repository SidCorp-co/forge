import { z } from 'zod';
import type { McpPrincipal } from '../../middleware/require-pat.js';
import { readPmSnapshot } from '../../pm/snapshot-service.js';
import { requireCan } from '../../permissions/index.js';

export const pmSnapshotInputSchema = z.object({ projectId: z.uuid() }).strict();

export async function pmSnapshotHandler(
  principal: McpPrincipal,
  input: z.infer<typeof pmSnapshotInputSchema>,
) {
  await requireCan({ userId: principal.userId }, 'project.read', input.projectId);
  return readPmSnapshot(input.projectId);
}
