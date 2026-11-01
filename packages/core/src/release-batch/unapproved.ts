import { sql } from 'drizzle-orm';
import { pipelineRuns } from '../db/schema.js';
import { writeRunMetadata } from '../pipeline/index.js';

// where the gate advises an approval, a production act that goes ahead with none says so on its
// release, once, at the first such act (REQ-79 r6): the release reads `unapproved`, never silent
export async function recordUnapproved(runId: string, mode: 'advise' | 'off'): Promise<void> {
  if (mode !== 'advise') return;
  await writeRunMetadata(runId, {
    merge: { unapproved: { at: new Date().toISOString() } },
    when: sql`${pipelineRuns.metadata} -> 'unapproved' is null`,
    touch: false,
  });
}
