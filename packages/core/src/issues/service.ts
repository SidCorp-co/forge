import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { withKernelMarker } from '../db/kernel-marker.js';
import { issues } from '../db/schema.js';

/** Deletes the issue row under the kernel marker. */
export async function deleteIssue(issueId: string): Promise<void> {
  await withKernelMarker(db, async (tx) => tx.delete(issues).where(eq(issues.id, issueId)));
}
