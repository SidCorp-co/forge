import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { knowledgeEntries, projects, uxContractRules } from '../db/schema.js';
import { upsertKnowledgeEntry } from '../knowledge/service.js';
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

  // cm:guard writing the prose is only half of shipping it — an `ux-contract` entry left `on_demand` is fetch-on-demand, and `forge-code`/`forge-clarify` both say it arrives "injected in your preamble", so a contract nobody flagged reaches no agent at all. Measured on forge-beta 2026-08-31: `qa-project-available-for-testing` had 22 active rules compiled to 2,925 characters and `alwaysInject` unset since 2026-08-11 — applied by the Settings button, injected nowhere, zero findings. Default it to `always` when NO entry exists yet; an entry a person already set is left at whatever they set it to.
  const [existing] = await db
    .select({ injection: knowledgeEntries.injection })
    .from(knowledgeEntries)
    .where(and(eq(knowledgeEntries.projectId, projectId), eq(knowledgeEntries.slug, 'ux-contract')))
    .limit(1);

  // Not caught: the knowledge entry IS the contract now, so a failed write means
  // the rules the operator just saved reach nobody. It used to be a best-effort
  // mirror of an `agentConfig.projectFacts` write and could be warned about;
  // warning about the only write there is would be a save that reports success
  // and did nothing (ISS-1048).
  await upsertKnowledgeEntry({
    projectId,
    slug: 'ux-contract',
    title: 'ux-contract',
    body: prose,
    kind: 'guide',
    injection: existing?.injection ?? 'always',
    confidence: 'verified',
    authoredBy: 'human',
    orderIndex: 0,
  });
}
