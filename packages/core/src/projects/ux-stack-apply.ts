import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import {
  type UxContractExecutor,
  recompileAndPersistUxContract,
  withUxContractTransaction,
} from './ux-contract-recompile.js';
import {
  type DetectedDesignSystem,
  type UxScanSnapshot,
  designSystemRuleTexts,
  detectDesignSystem,
} from './ux-stack-scan.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface UxScanResult {
  detected: DetectedDesignSystem;
  mode: 'created' | 'proposed' | 'unchanged' | 'superseded';
  activeWritten: number;
  proposed: number;
}

export async function reserveUxScanGeneration(projectId: string): Promise<number> {
  return withUxContractTransaction(projectId, async (tx) => {
    const [project] = await tx
      .select({ agentConfig: projects.agentConfig })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const profile = (
      project?.agentConfig as { uxContractProfile?: { scanGeneration?: unknown } } | undefined
    )?.uxContractProfile;
    const generation = typeof profile?.scanGeneration === 'number' ? profile.scanGeneration + 1 : 1;
    await tx
      .update(projects)
      .set({
        agentConfig: sql`jsonb_set(
          COALESCE(${projects.agentConfig}, '{}'::jsonb),
          '{uxContractProfile}',
          COALESCE(${projects.agentConfig} -> 'uxContractProfile', '{}'::jsonb) ||
            jsonb_build_object('scanGeneration', ${generation}),
          true
        )`,
      })
      .where(eq(projects.id, projectId));
    return generation;
  });
}

async function persistDetectionProfile(
  executor: UxContractExecutor,
  projectId: string,
  packageDir: string,
  detected: DetectedDesignSystem,
): Promise<void> {
  const detectedJson = JSON.stringify(detected);
  await executor
    .update(projects)
    .set({
      // cm:guard only patch uxContractProfile in SQL — a scan may overlap an agentConfig update from another surface
      agentConfig: sql`jsonb_set(
        COALESCE(${projects.agentConfig}, '{}'::jsonb),
        '{uxContractProfile}',
        COALESCE(${projects.agentConfig} -> 'uxContractProfile', '{}'::jsonb) ||
          jsonb_build_object(
            'projectLabel', COALESCE(${projects.agentConfig} #>> '{uxContractProfile,projectLabel}', ${packageDir}),
            'bindingScope', COALESCE(${projects.agentConfig} #>> '{uxContractProfile,bindingScope}', ${`${packageDir}/`}),
            'knownGaps', COALESCE(${projects.agentConfig} #> '{uxContractProfile,knownGaps}', '[]'::jsonb),
            'designSystem', ${detectedJson}::jsonb
          ),
        true
      )`,
    })
    .where(eq(projects.id, projectId));
}

async function hasHandAuthoredContract(tx: Tx | Db, projectId: string): Promise<boolean> {
  const [row] = await tx
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const facts = (row?.agentConfig as { projectFacts?: Record<string, string> } | undefined)
    ?.projectFacts;
  const prose = facts?.['ux-contract'];
  return typeof prose === 'string' && prose.trim().length > 0;
}

interface ScanOutcome {
  mode: UxScanResult['mode'];
  activeWritten: number;
  proposed: number;
}

type ExistingRuleRow = {
  id: string;
  text: string;
  status: string;
  source: string;
  orderIndex: number;
};

function hasMatchingProposal(rows: ExistingRuleRow[], orderIndex: number, text: string): boolean {
  return rows.some(
    (row) =>
      row.status === 'proposed' &&
      row.source === 'detected' &&
      row.orderIndex === orderIndex &&
      row.text === text,
  );
}

function proposalMatchesGenerated(
  row: ExistingRuleRow,
  generated: ReturnType<typeof designSystemRuleTexts>,
): boolean {
  return (
    row.status === 'proposed' &&
    row.source === 'detected' &&
    generated.some((rule) => rule.orderIndex === row.orderIndex && rule.text === row.text)
  );
}

export async function applyUxScan(
  projectId: string,
  snapshot: UxScanSnapshot,
  generation?: number,
): Promise<UxScanResult> {
  const detected = detectDesignSystem(snapshot);
  const generated = designSystemRuleTexts(detected);

  const outcome = await withUxContractTransaction(projectId, async (tx): Promise<ScanOutcome> => {
    if (generation !== undefined) {
      const [project] = await tx
        .select({ agentConfig: projects.agentConfig })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      const currentGeneration = (
        project?.agentConfig as { uxContractProfile?: { scanGeneration?: unknown } } | undefined
      )?.uxContractProfile?.scanGeneration;
      if (currentGeneration !== generation) {
        return { mode: 'superseded', activeWritten: 0, proposed: 0 };
      }
    }
    await persistDetectionProfile(tx, projectId, snapshot.packageDir, detected);

    const existingRows: ExistingRuleRow[] = await tx
      .select({
        id: uxContractRules.id,
        text: uxContractRules.text,
        status: uxContractRules.status,
        source: uxContractRules.source,
        orderIndex: uxContractRules.orderIndex,
      })
      .from(uxContractRules)
      .where(
        and(eq(uxContractRules.projectId, projectId), eq(uxContractRules.group, 'designSystem')),
      );

    if (existingRows.length === 0) {
      const [anyRuleRow] = await tx
        .select({ id: uxContractRules.id })
        .from(uxContractRules)
        .where(eq(uxContractRules.projectId, projectId))
        .limit(1);
      const handAuthored = !anyRuleRow && (await hasHandAuthoredContract(tx, projectId));

      await tx.insert(uxContractRules).values(
        generated.map((t) => ({
          projectId,
          group: 'designSystem' as const,
          text: t.text,
          severity: t.severity,
          source: 'detected' as const,
          status: (handAuthored ? 'proposed' : 'active') as 'proposed' | 'active',
          orderIndex: t.orderIndex,
        })),
      );

      if (handAuthored) {
        await tx
          .update(projects)
          .set({
            agentConfig: sql`jsonb_set(
              COALESCE(${projects.agentConfig}, '{}'::jsonb),
              '{uxContractProfile,preserveProse}',
              'true'::jsonb,
              true
            )`,
          })
          .where(eq(projects.id, projectId));
      } else {
        await recompileAndPersistUxContract(projectId, tx);
      }
      return {
        mode: handAuthored ? 'proposed' : 'created',
        activeWritten: handAuthored ? 0 : generated.length,
        proposed: handAuthored ? generated.length : 0,
      };
    }

    const activeByOrder = new Map(
      existingRows.filter((row) => row.status === 'active').map((row) => [row.orderIndex, row]),
    );
    const drifted = generated.filter(
      (rule) => activeByOrder.get(rule.orderIndex)?.text !== rule.text,
    );
    const desiredProposals = drifted.filter(
      (rule) => !hasMatchingProposal(existingRows, rule.orderIndex, rule.text),
    );
    const staleDetectedProposalIds = existingRows
      .filter(
        (row) =>
          row.status === 'proposed' &&
          row.source === 'detected' &&
          !proposalMatchesGenerated(row, drifted),
      )
      .map((row) => row.id);

    if (staleDetectedProposalIds.length > 0) {
      await tx.delete(uxContractRules).where(inArray(uxContractRules.id, staleDetectedProposalIds));
    }
    if (desiredProposals.length > 0) {
      await tx.insert(uxContractRules).values(
        desiredProposals.map((rule) => ({
          projectId,
          group: 'designSystem' as const,
          text: rule.text,
          severity: rule.severity,
          source: 'detected' as const,
          status: 'proposed' as const,
          orderIndex: rule.orderIndex,
        })),
      );
    }

    return {
      mode: drifted.length === 0 ? 'unchanged' : 'proposed',
      activeWritten: 0,
      proposed: desiredProposals.length,
    };
  });

  return { detected, ...outcome };
}
