import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import { compileUxContract } from './ux-contract-compiler.js';
import { mergeProjectFacts } from './project-facts.js';

export async function recompileAndPersistUxContract(projectId: string): Promise<void> {
  const rules = await db
    .select({
      group: uxContractRules.group,
      text: uxContractRules.text,
      status: uxContractRules.status,
      orderIndex: uxContractRules.orderIndex,
    })
    .from(uxContractRules)
    .where(and(eq(uxContractRules.projectId, projectId), eq(uxContractRules.status, 'active')))
    .orderBy(asc(uxContractRules.orderIndex));

  const prose = compileUxContract(rules);

  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return;

  const ac = { ...((row.agentConfig ?? {}) as Record<string, unknown>) };
  const merged = mergeProjectFacts(ac.projectFacts, { 'ux-contract': prose });
  const updatedAc = merged !== null ? { ...ac, projectFacts: merged } : { ...ac };

  await db.update(projects).set({ agentConfig: updatedAc }).where(eq(projects.id, projectId));
}
