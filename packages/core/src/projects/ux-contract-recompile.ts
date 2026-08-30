import { and, asc, eq } from 'drizzle-orm';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import { upsertKnowledgeEntry } from '../knowledge/service.js';
import { logger } from '../logger.js';
import { mergeProjectFacts } from './project-facts.js';
import {
  compileUxContract,
  DEFAULT_UX_SCAFFOLD,
  type UxContractScaffold,
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

  // cm:guard writing the prose is only half of shipping it — an `ux-contract` fact with no `alwaysInject` is fetch-on-demand, and `forge-code`/`forge-clarify` both say it arrives "injected in your preamble", so a contract nobody flagged reaches no agent at all. Measured on forge-beta 2026-08-31: `qa-project-available-for-testing` had 22 active rules compiled to 2,925 characters and `alwaysInject` unset since 2026-08-11 — applied by the Settings button, injected nowhere, zero findings. Default it ON when the key is ABSENT only; an explicit `false` is a human's decision and is left alone.
  const factsConfig =
    (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {};
  const updatedFactsConfig =
    factsConfig['ux-contract'] === undefined
      ? { ...factsConfig, 'ux-contract': { alwaysInject: true } }
      : factsConfig;

  const updatedAc =
    merged !== null
      ? { ...ac, projectFacts: merged, projectFactsConfig: updatedFactsConfig }
      : { ...ac, projectFactsConfig: updatedFactsConfig };

  await db.update(projects).set({ agentConfig: updatedAc }).where(eq(projects.id, projectId));

  // cm:edge lockstep -> packages/core/src/projects/project-facts-routes.ts — same knowledge_entries write-through, keep guard/shape in sync
  // cm:edge lockstep -> packages/core/src/mcp/tools/forge-config.ts — same knowledge_entries write-through, keep guard/shape in sync
  if (env.KNOWLEDGE_INJECTION_ENABLED) {
    const alwaysInject = updatedFactsConfig['ux-contract']?.alwaysInject === true;
    await upsertKnowledgeEntry({
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
