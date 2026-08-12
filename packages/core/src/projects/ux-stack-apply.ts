import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { db } from '../db/client.js';
import { projects, uxContractRules } from '../db/schema.js';
import type { UxStackProfile } from './ux-contract-presets.js';
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
  const [row] = await db
    .select({ agentConfig: projects.agentConfig })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const ac = { ...((row?.agentConfig ?? {}) as Record<string, unknown>) };
  const existingProfile = ac.uxContractProfile as Partial<UxStackProfile> | undefined;

  const profile: UxStackProfile = {
    projectLabel: existingProfile?.projectLabel ?? packageDir,
    bindingScope: existingProfile?.bindingScope ?? `${packageDir}/`,
    knownGaps: existingProfile?.knownGaps ?? [],
    ...(existingProfile?.ruleOverrides ? { ruleOverrides: existingProfile.ruleOverrides } : {}),
    designSystem: detected,
  };

  await db
    .update(projects)
    .set({ agentConfig: { ...ac, uxContractProfile: profile } })
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

interface FirstRunOutcome {
  firstRun: true;
  handAuthored: boolean;
}
interface NotFirstRunOutcome {
  firstRun: false;
  existingRows: Array<{
    id: string;
    text: string;
    status: string;
    source: string;
    orderIndex: number;
  }>;
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

  const outcome: FirstRunOutcome | NotFirstRunOutcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ux-scan:' || ${projectId}))`);

    const existingRows = await tx
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

    if (existingRows.length !== 0) return { firstRun: false, existingRows };

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

    return { firstRun: true, handAuthored };
  });

  if (outcome.firstRun) {
    if (outcome.handAuthored) {
      return {
        detected,
        mode: 'proposed',
        activeWritten: 0,
        proposed: generated.length,
      };
    }
    await recompileAndPersistUxContract(projectId);
    return {
      detected,
      mode: 'created',
      activeWritten: generated.length,
      proposed: 0,
    };
  }

  const existingRows = outcome.existingRows;
  const activeByOrder = new Map(
    existingRows.filter((r) => r.status === 'active').map((r) => [r.orderIndex, r]),
  );
  const drifted = generated.filter((t) => activeByOrder.get(t.orderIndex)?.text !== t.text);

  // Clear leftover detected proposals — the drift resolved itself, or is about
  // to be replaced below. Never touch proposals from other sources (preset,
  // learned, manual) — those belong to a different approval flow.
  const staleDetectedProposalIds = existingRows
    .filter((r) => r.status === 'proposed' && r.source === 'detected')
    .map((r) => r.id);
  if (staleDetectedProposalIds.length > 0) {
    await db.delete(uxContractRules).where(inArray(uxContractRules.id, staleDetectedProposalIds));
  }

  if (drifted.length === 0) {
    return { detected, mode: 'unchanged', activeWritten: 0, proposed: 0 };
  }

  await db.insert(uxContractRules).values(
    drifted.map((t) => ({
      projectId,
      group: 'designSystem' as const,
      text: t.text,
      severity: t.severity,
      source: 'detected' as const,
      status: 'proposed' as const,
      orderIndex: t.orderIndex,
    })),
  );

  return {
    detected,
    mode: 'proposed',
    activeWritten: 0,
    proposed: drifted.length,
  };
}
