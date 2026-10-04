import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { channelDocuments } from '../db/schema-ecosystem.js';
import { agentQuestions, isChoiceStep } from '../db/schema-questions.js';
import { effectiveProjectRole } from '../lib/authz.js';
import { actorFor, visibleFilter } from '../permissions/index.js';
import { mayChoose } from '../questions/write.js';

export const CHANNEL_GATES_CAP = 20;

export interface AttentionGateRow {
  questionId: string;
  number: string;
  documentId: string;
  /** The waiting document's type, so the row names what waits rather than that a decision does. */
  documentType: string | null;
  prompt: string;
  createdAt: Date;
  projectSlug: string;
  projectName: string;
}

// cm:why a gate question is listed only for a person whose role on the sending project may choose one of its options, which is the rule `answerQuestion` applies, so the list never offers a decision the answer would refuse
export async function selectChannelGates(userId: string): Promise<AttentionGateRow[]> {
  const rows = await db
    .select({
      questionId: agentQuestions.id,
      projectId: agentQuestions.projectId,
      origin: agentQuestions.origin,
      steps: agentQuestions.steps,
      createdAt: agentQuestions.createdAt,
      projectSlug: projects.slug,
      projectName: projects.name,
      documentType: channelDocuments.type,
    })
    .from(agentQuestions)
    .innerJoin(projects, eq(projects.id, agentQuestions.projectId))
    .leftJoin(
      channelDocuments,
      sql`${channelDocuments.id}::text = ${agentQuestions.origin}->>'documentId'`,
    )
    .where(
      and(
        eq(agentQuestions.status, 'open'),
        sql`${agentQuestions.origin}->>'kind' = 'channel_gate'`,
        visibleFilter(actorFor(userId), 'project.read', {
          type: 'question',
          projectId: agentQuestions.projectId,
        }),
      ),
    )
    .orderBy(desc(agentQuestions.createdAt));
  const roles = new Map<string, Awaited<ReturnType<typeof effectiveProjectRole>>>();
  for (const projectId of new Set(rows.map((r) => r.projectId))) {
    roles.set(projectId, await effectiveProjectRole(userId, projectId));
  }
  return rows
    .flatMap((r) => {
      const current = r.steps.at(-1);
      if (r.origin?.kind !== 'channel_gate' || !current || !isChoiceStep(current)) return [];
      const access = roles.get(r.projectId) ?? null;
      if (!current.options.some((o) => mayChoose(o, access))) return [];
      return [
        {
          questionId: r.questionId,
          number: r.origin.number,
          documentId: r.origin.documentId,
          documentType: r.documentType,
          prompt: current.prompt,
          createdAt: r.createdAt,
          projectSlug: r.projectSlug,
          projectName: r.projectName,
        },
      ];
    })
    .slice(0, CHANNEL_GATES_CAP);
}
