// A room agent keeps what it learns (ISS-1485, REQ-107 BC-5): one summary of the project, a recurring
// technical problem or a user, written as a project knowledge entry the agent authors under its own
// account, with where it applies, the change that means it needs checking again, and the case it came
// from. The entry is read back by relevance, in the turn (`kept-cases.ts`), never in the always-on brief.
// It is a fact the agent owns, not a decision: a precedent stays the owner's alone (`SUPPORT_PRECEDENT_PREFIX`,
// written with `owner_forge_act` rule.write), and this act's slug is always `case-<topic>`, so it cannot
// write one. An entry a person wrote under the same slug is never rewritten by it.

import { SUPPORT_KEPT_PREFIX, type SupportKeepRequest } from '@forge/contracts/support-keep';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries } from '../db/schema.js';
import { upsertKnowledgeEntry } from '../knowledge/index.js';
import { namedProject } from './ops-scope.js';
import type { OpsOutcome } from './ops-types.js';
import { refusalsOf } from './ops-writes.js';
import { knownThread, no } from './outcome.js';
import { asRoomAgent } from './reference-acts.js';
import type { RoomRow } from './store.js';

export type KeepActInput = { action: 'keep' } & SupportKeepRequest;

/** `keep`: the summary, written as the room agent's own fact; the one under a topic is rewritten. */
export async function keepAct(room: RoomRow, input: KeepActInput): Promise<OpsOutcome<unknown>> {
  const project = await namedProject(room, input.project);
  if (!project.ok) return project;
  if (!(await knownThread(room, input.thread))) {
    return no(
      'SUPPORT_THREAD_UNKNOWN',
      '/thread',
      `no member has written in thread ${input.thread} of this group: a summary names the case it came from`,
    );
  }
  const { id, slug: projectSlug } = project.value;
  const slug = `${SUPPORT_KEPT_PREFIX}${input.topic}`;
  const [held] = await db
    .select({ authoredBy: knowledgeEntries.authoredBy })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, id), eq(knowledgeEntries.slug, slug)))
    .limit(1);
  if (held && held.authoredBy !== 'agent') {
    return no(
      'SUPPORT_REFUSED',
      '/topic',
      `${slug} is an entry a person wrote, and a kept summary never rewrites one: keep this under another topic`,
    );
  }
  return refusalsOf(() =>
    asRoomAgent(room, id, async () => {
      const written = await upsertKnowledgeEntry(
        {
          projectId: id,
          slug,
          title: input.title,
          body: input.learned,
          kind: 'guide',
          injection: 'on_demand',
          confidence: 'inferred',
          authoredBy: 'agent',
          orderIndex: 0,
          source: `case: thread ${input.thread} of room ${room.id}, kept ${new Date().toISOString().slice(0, 10)}; concerns ${input.concerns}`,
          scope: input.scope,
          recheckWhen: input.recheckWhen,
        },
        { userId: room.principalUserId, agency: 'agent' },
      );
      return {
        ok: true as const,
        value: { project: projectSlug, kept: written.slug, concerns: input.concerns },
      };
    }),
  );
}
