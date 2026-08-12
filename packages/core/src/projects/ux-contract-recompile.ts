import { and, asc, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import { upsertKnowledgeEntry } from '../knowledge/service.js';
import { logger } from '../logger.js';
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

  // cm:edge lockstep -> packages/core/src/projects/project-facts-routes.ts — same knowledge_entries write-through, keep guard/shape in sync
  // cm:edge lockstep -> packages/core/src/mcp/tools/forge-config.ts — same knowledge_entries write-through, keep guard/shape in sync
  if (env.KNOWLEDGE_INJECTION_ENABLED) {
    const factsConfig =
      (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {};
    const alwaysInject = factsConfig['ux-contract']?.alwaysInject === true;
    upsertKnowledgeEntry({
      projectId,
      slug: 'ux-contract',
      title: 'ux-contract',
      body: prose,
      kind: 'guide',
      injection: alwaysInject ? 'always' : 'on_demand',
      confidence: 'verified',
      authoredBy: 'human',
      orderIndex: merged !== null ? Object.keys(merged).indexOf('ux-contract') : -1,
    }).catch((err: Error) => {
      logger.warn(
        { err: err.message, projectId },
        'ux-contract recompile: knowledge write-through failed',
      );
    });
  }
}
