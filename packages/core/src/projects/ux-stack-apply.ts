import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import { recompileAndPersistUxContract } from './ux-contract-recompile.js';
import {
  type DetectedDesignSystem,
  type UxScanSnapshot,
  designSystemRuleTexts,
  detectDesignSystem,
} from './ux-stack-scan.js';

// ISS-576 — persistence + drift for the §1 auto-detect scan. The profile
// (`agentConfig.uxContractProfile.designSystem`) is a DETECTION RECORD updated
// on EVERY scan so the Detected-stack panel is never stale; only the derived
// `ux_contract_rules` go through the human propose/approve gate.

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface UxScanResult {
  detected: DetectedDesignSystem;
  mode: 'created' | 'proposed' | 'unchanged';
  activeWritten: number;
  proposed: number;
}

async function persistDetectionProfile(
  projectId: string,
  packageDir: string,
  detected: DetectedDesignSystem,
): Promise<void> {
  const detectedJson = JSON.stringify(detected);
  await db
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

// A project may already carry a hand-authored `projectFacts['ux-contract']`
// (forge-dev's own, pre-ISS-841) that was never compiled from rules. If no
// `ux_contract_rules` row exists yet for ANY group, that prose is the ONLY
// governing contract — recompiling now would replace it with a
// designSystem-only stub (`compileUxContract` builds from active rules only).
// Detect that case so the first-run branch can route detected rules through
// the human propose/approve gate instead of auto-activating + recompiling.
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
  recompile: boolean;
  preserveProse: boolean;
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

/**
 * Run a scan against `snapshot` and persist its results for `projectId`.
 *
 * - Always updates the detection profile (never stale).
 * - First scan (no `designSystem` rows at all) writes 4 active `source:'detected'`
 *   rules and recompiles the prose — unless the project has a hand-authored
 *   contract and no rules at all yet, in which case the rules are proposed
 *   instead (see `hasHandAuthoredContract`).
 * - A later scan diffs the generated texts against the current ACTIVE rows by
 *   `orderIndex`: no diff → no rule writes (besides clearing stale proposals,
 *   which makes a resolved drift self-correcting); any diff → replace the
 *   `status:'proposed' AND source:'detected'` set with only the changed rules,
 *   leaving active rows untouched until a human approves via the existing inbox.
 *
 * The first-run check + insert runs under a per-project advisory lock so a
 * double-dispatched scan can't race past the empty-table check and insert
 * duplicate active rows.
 */
export async function applyUxScan(
  projectId: string,
  snapshot: UxScanSnapshot,
): Promise<UxScanResult> {
  const detected = detectDesignSystem(snapshot);
  await persistDetectionProfile(projectId, snapshot.packageDir, detected);

  const generated = designSystemRuleTexts(detected);

  const outcome: ScanOutcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ux-scan:' || ${projectId}))`);

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
      }
      return {
        mode: handAuthored ? 'proposed' : 'created',
        activeWritten: handAuthored ? 0 : generated.length,
        proposed: handAuthored ? generated.length : 0,
        recompile: !handAuthored,
        preserveProse: handAuthored,
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
      recompile: false,
      preserveProse: false,
    };
  });

  if (outcome.recompile) await recompileAndPersistUxContract(projectId);
  const { preserveProse: _preserveProse, recompile: _recompile, ...result } = outcome;
  return { detected, ...result };
}
