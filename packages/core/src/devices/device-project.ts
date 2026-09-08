// Is this box bound to that project at all.
//
// One implementation, because two would grant and deny differently with
// nothing comparing them — and a device route that answers for a project the
// box is not a runner for is cross-project leakage on a credential that is
// deliberately narrower than its owner's.

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
