import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import { mergeProjectFacts } from './project-facts.js';
import {
  DEFAULT_UX_SCAFFOLD,
  type UxContractScaffold,
  compileUxContract,
} from './ux-contract-compiler.js';

// The project's UX-contract profile lives at `agentConfig.uxContractProfile`
// (written by the preset apply path / auto-detect). Only its scaffold fields
// are needed at recompile time — rule overrides were already baked into
// `ux_contract_rules` rows when the preset was applied.
function scaffoldFromAgentConfig(ac: Record<string, unknown>): UxContractScaffold {
  const profile = ac.uxContractProfile as Partial<UxContractScaffold> | undefined;
  if (!profile || typeof profile.projectLabel !== 'string') return DEFAULT_UX_SCAFFOLD;
  return {
    projectLabel: profile.projectLabel,
    bindingScope:
      typeof profile.bindingScope === 'string'
        ? profile.bindingScope
        : DEFAULT_UX_SCAFFOLD.bindingScope,
    knownGaps: Array.isArray(profile.knownGaps)
      ? profile.knownGaps.filter((g): g is string => typeof g === 'string')
      : [],
  };
}

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

  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return;

  const ac = { ...((row.agentConfig ?? {}) as Record<string, unknown>) };
  const prose = compileUxContract(rules, scaffoldFromAgentConfig(ac));

  const merged = mergeProjectFacts(ac.projectFacts, { 'ux-contract': prose });
  const updatedAc = merged !== null ? { ...ac, projectFacts: merged } : { ...ac };

  await db.update(projects).set({ agentConfig: updatedAc }).where(eq(projects.id, projectId));
}
