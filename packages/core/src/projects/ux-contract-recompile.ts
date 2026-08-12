import { and, asc, eq, sql } from 'drizzle-orm';
import { env } from '../config/env.js';
import type { Db } from '../db/client.js';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import { upsertKnowledgeEntry } from '../knowledge/service.js';
import { logger } from '../logger.js';
import {
  DEFAULT_UX_SCAFFOLD,
  type UxContractScaffold,
  compileUxContract,
} from './ux-contract-compiler.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type UxContractExecutor = Db | Tx;

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

export async function withUxContractTransaction<T>(
  projectId: string,
  operation: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ux-contract:' || ${projectId}))`);
    return operation(tx);
  });
}

export async function recompileAndPersistUxContract(
  projectId: string,
  executor: UxContractExecutor = db,
): Promise<void> {
  const rules = await executor
    .select({
      group: uxContractRules.group,
      text: uxContractRules.text,
      status: uxContractRules.status,
      orderIndex: uxContractRules.orderIndex,
    })
    .from(uxContractRules)
    .where(and(eq(uxContractRules.projectId, projectId), eq(uxContractRules.status, 'active')))
    .orderBy(asc(uxContractRules.orderIndex));

  const [row] = await executor
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) return;

  const ac = (row.agentConfig ?? {}) as Record<string, unknown>;
  const profile = ac.uxContractProfile as { preserveProse?: unknown } | undefined;
  if (profile?.preserveProse === true) return;
  const prose = compileUxContract(rules, scaffoldFromAgentConfig(ac));
  const facts =
    ac.projectFacts && typeof ac.projectFacts === 'object' && !Array.isArray(ac.projectFacts)
      ? (ac.projectFacts as Record<string, unknown>)
      : {};

  await executor
    .update(projects)
    .set({
      // cm:guard patch projectFacts in SQL — a UX scan may overlap another agentConfig settings update
      agentConfig: sql`jsonb_set(
        COALESCE(${projects.agentConfig}, '{}'::jsonb),
        '{projectFacts}',
        COALESCE(${projects.agentConfig} -> 'projectFacts', '{}'::jsonb) ||
          jsonb_build_object('ux-contract', ${prose}),
        true
      )`,
    })
    .where(eq(projects.id, projectId));

  // cm:edge lockstep -> packages/core/src/projects/project-facts-routes.ts — same knowledge_entries write-through, keep guard/shape in sync
  // cm:edge lockstep -> packages/core/src/mcp/tools/forge-config.ts — same knowledge_entries write-through, keep guard/shape in sync
  if (env.KNOWLEDGE_INJECTION_ENABLED) {
    const factsConfig =
      (ac.projectFactsConfig as Record<string, { alwaysInject?: boolean }> | undefined) ?? {};
    const alwaysInject = factsConfig['ux-contract']?.alwaysInject === true;
    await upsertKnowledgeEntry({
      projectId,
      slug: 'ux-contract',
      title: 'ux-contract',
      body: prose,
      kind: 'guide',
      injection: alwaysInject ? 'always' : 'on_demand',
      confidence: 'verified',
      authoredBy: 'human',
      orderIndex: Object.keys(facts).indexOf('ux-contract'),
    }).catch((err: Error) => {
      logger.warn(
        { err: err.message, projectId },
        'ux-contract recompile: knowledge write-through failed',
      );
    });
  }
}
