// The kept probes of an issue's criteria (REQ-36 BC-6; ISS-469): the probe a verdict sends is kept,
// a verdict that sends none rests on its criterion's newest, and the criteria read answers each
// criterion's kept probe. The rules are `probe-rules.ts`; nothing here runs a probe.

import type {
  CriterionProbe,
  CriterionProbeView,
  ProbeRouting,
} from '@forge/contracts/criterion-probes';
import type { CriterionClass } from '@forge/contracts/issue-design';
import { desc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';
import { criterionProbes } from '../../db/schema-issue-criteria.js';
import { RefusalError } from '../../lib/refusal.js';
import { type IssueProjectDocument, readProjectDocument } from '../ports.js';
import {
  probeRouteRefusal,
  probeRuleFault,
  probeSecretRefusals,
  restsOnKept,
} from './probe-rules.js';

type DeclaredEnvironment = IssueProjectDocument['environments'][string] & {
  url?: string | undefined;
  services?: Record<string, string> | undefined;
  routes?: Record<string, string[]> | undefined;
  deployment?: { mode?: string | undefined } | undefined;
};

/**
 * The production environment a kept request probe is replayed against; null where none is: no
 * production, or one deployed outside Forge, which no release run deploys and so none replays on.
 */
async function productionRouting(projectId: string): Promise<ProbeRouting | null> {
  const document = (await readProjectDocument(projectId))?.document ?? null;
  const environments = Object.entries(document?.environments ?? {}) as [
    string,
    DeclaredEnvironment,
  ][];
  const found = environments.find(([, e]) => e.tier === 'production');
  if (!found || found[1].deployment?.mode === 'external') return null;
  const [environment, e] = found;
  return { environment, url: e.url ?? null, services: e.services ?? {}, routes: e.routes ?? null };
}

async function keptProbeIdOf(tx: Tx, criterionId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: criterionProbes.id })
    .from(criterionProbes)
    .where(eq(criterionProbes.criterionId, criterionId))
    .orderBy(desc(criterionProbes.createdAt), desc(criterionProbes.id))
    .limit(1);
  return row?.id ?? null;
}

/**
 * The probe a verdict rests on, kept first where the verdict sends one; null where it rests on none.
 * Refuses, before anything is written, a probe holding a credential, a probe on a code property, a
 * request the production origin it would be replayed against does not answer, and a pass or short
 * on an observable criterion that neither sends a probe nor finds one kept.
 */
export async function probeOfVerdict(
  tx: Tx,
  args: {
    issueId: string;
    projectId: string;
    criterion: { id: string; n: number; class: CriterionClass | null };
    verdict: string;
    probe: CriterionProbe | null;
  },
): Promise<string | null> {
  const { criterion, verdict, probe } = args;
  const kept = probe ? null : await keptProbeIdOf(tx, criterion.id);
  const fault = probeRuleFault({
    criterion: criterion.n,
    criterionClass: criterion.class,
    verdict,
    sent: probe !== null,
    kept: kept !== null,
  });
  const routing = probe?.kind === 'request' ? await productionRouting(args.projectId) : null;
  const service = probe && routing ? probeRouteRefusal(probe, routing) : null;
  const refusals = [
    ...(fault ? [fault] : []),
    ...(probe ? probeSecretRefusals(probe) : []),
    ...(service ? [service] : []),
  ];
  if (refusals.length > 0) throw new RefusalError(refusals, 'VERDICT_REFUSED');
  if (!probe) {
    return kept && criterion.class !== 'code_property' && restsOnKept(verdict) ? kept : null;
  }
  const [row] = await tx
    .insert(criterionProbes)
    .values({ criterionId: criterion.id, issueId: args.issueId, kind: probe.kind, spec: probe })
    .returning({ id: criterionProbes.id });
  if (!row) throw new Error('criterion_probes insert returned no row');
  return row.id;
}

/** Each criterion's kept probe, by criterion id; a criterion that keeps none is absent. */
export async function keptProbesOf(
  executor: Pick<Tx, 'select'>,
  criterionIds: readonly string[],
): Promise<Map<string, CriterionProbeView>> {
  if (criterionIds.length === 0) return new Map();
  const rows = await executor
    .select()
    .from(criterionProbes)
    .where(inArray(criterionProbes.criterionId, [...criterionIds]))
    .orderBy(desc(criterionProbes.createdAt), desc(criterionProbes.id));
  const out = new Map<string, CriterionProbeView>();
  for (const row of rows) {
    if (out.has(row.criterionId)) continue;
    out.set(row.criterionId, {
      ...(row.spec as CriterionProbe),
      id: row.id,
      keptAt: row.createdAt.toISOString(),
    });
  }
  return out;
}
