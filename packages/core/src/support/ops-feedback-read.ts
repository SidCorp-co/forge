// A room agent's read of a reached project's feedback (ISS-1243 item 11): where each item stands,
// newest first, or one item by its key. Forge-Communicate's operations room answered the owner's ask
// for epod's feedback status on 2026-11-15 with "this room is not granted the feedback list", since
// no act read it; it runs as the room, over the projects its reach holds (`ops-scope.ts`), as the
// issue and release reads do.

import { feedbackKey } from '@forge/contracts/feedback';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { linkedOf, phaseIn } from '../feedback/index.js';
import { projectInScope } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { no } from './outcome.js';
import type { RoomRow } from './store.js';
import { scrubbedForRoom } from './thread.js';

/** How many items a list read carries. */
const FEEDBACK_ROWS = 30;

export async function feedbackRead(
  room: RoomRow,
  input: { project: string; key?: string | undefined },
): Promise<OpsOutcome<unknown>> {
  const project = await projectInScope(room, input.project);
  if (!project.ok) return project;
  const seq = input.key ? Number(input.key.replace(/^FB-/i, '')) : null;
  if (input.key && !Number.isInteger(seq)) {
    return no('OPS_OUT_OF_SCOPE', '/key', `${input.key} is no feedback key; one reads FB-12`);
  }
  const rows = await db
    .select()
    .from(feedback)
    .where(
      seq === null
        ? eq(feedback.projectId, project.value.id)
        : and(eq(feedback.projectId, project.value.id), eq(feedback.fbSeq, seq)),
    )
    .orderBy(desc(feedback.createdAt))
    .limit(FEEDBACK_ROWS);
  if (input.key && rows.length === 0) {
    return no(
      'OPS_OUT_OF_SCOPE',
      '/key',
      `${input.key} names no feedback item of ${project.value.slug}`,
    );
  }
  const linked = await linkedOf(project.value.id, rows);
  return {
    ok: true,
    value: {
      project: project.value.slug,
      feedback: await Promise.all(
        rows.map(async (r) => ({
          key: feedbackKey(r.fbSeq),
          title: await scrubbedForRoom(room, r.title),
          phase: phaseIn(r, linked),
          at: r.createdAt.toISOString(),
        })),
      ),
    },
  };
}
