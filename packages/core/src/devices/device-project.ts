import { and, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { runners } from '../db/schema.js';

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
    throw new HTTPException(403, {
      message: 'device not bound to project',
      cause: { code: 'FORBIDDEN' },
    });
  }
}
