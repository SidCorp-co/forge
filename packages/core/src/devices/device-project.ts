import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';
import { forbidden } from '../middleware/route-errors.js';

export async function assertDeviceBoundToProject(
  deviceId: string,
  projectId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.deviceId, deviceId),
        eq(runners.projectId, projectId),
        eq(runners.type, 'claude-code'),
      ),
    )
    .limit(1);
  if (!row) {
    throw forbidden('device not bound to project');
  }
}
