import { and, eq, inArray } from 'drizzle-orm';
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

/**
 * Run a scan against `snapshot` and persist its results for `projectId`.
 *
 * - Always updates the detection profile (never stale).
 * - First scan (no `designSystem` rows at all) writes 4 active `source:'detected'`
 *   rules and recompiles the prose.
 * - A later scan diffs the generated texts against the current ACTIVE rows by
 *   `orderIndex`: no diff → no rule writes (besides clearing stale proposals,
 *   which makes a resolved drift self-correcting); any diff → replace the
 *   `status:'proposed' AND source:'detected'` set with only the changed rules,
 *   leaving active rows untouched until a human approves via the existing inbox.
 */
export async function applyUxScan(
  projectId: string,
  snapshot: UxScanSnapshot,
): Promise<UxScanResult> {
  const detected = detectDesignSystem(snapshot);
  await persistDetectionProfile(projectId, snapshot.packageDir, detected);

  const generated = designSystemRuleTexts(detected);

  const existingRows = await db
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
    await db.insert(uxContractRules).values(
      generated.map((t) => ({
        projectId,
        group: 'designSystem' as const,
        text: t.text,
        severity: t.severity,
        source: 'detected' as const,
        status: 'active' as const,
        orderIndex: t.orderIndex,
      })),
    );
    await recompileAndPersistUxContract(projectId);
    return { detected, mode: 'created', activeWritten: generated.length, proposed: 0 };
  }

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

  return { detected, mode: 'proposed', activeWritten: 0, proposed: drifted.length };
}
