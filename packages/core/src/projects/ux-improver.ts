// UX Improver, persistence half — ISS-579. Loads the fuel, runs the pure
// detector in `ux-improver-detect.ts`, and commits the candidates an agent
// selected.
//
// Nothing in this module can ACTIVATE a rule — `add` and `strengthen` land at
// status `proposed` with source `learned`, and approving one is the human's move
// in project settings. That is the propose-only guarantee the UX Completeness
// Contract epic locked in, and it is about activation, not about every write:
// `retire` is applied here rather than proposed, because it only ever withdraws
// an unapproved proposal the improver itself authored (evidence-backed, source
// `learned`), which no human ever agreed to.

import type { UxImproverProposalOutcome, UxImproverReport } from '@forge/contracts';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { uxContractRules, uxFindings } from '../db/schema.js';
import { recompileAndPersistUxContract } from './ux-contract-recompile.js';
import {
  detectUxImproverCandidates,
  jaccard,
  LOOKBACK_DAYS,
  normalizeTokens,
  SIMILARITY_THRESHOLD,
} from './ux-improver-detect.js';

const DAY_MS = 86_400_000;

export async function loadUxImproverReport(
  projectId: string,
  now: Date = new Date(),
): Promise<UxImproverReport> {
  const cutoff = new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS);

  const findingRows = await db
    .select()
    .from(uxFindings)
    .where(and(eq(uxFindings.projectId, projectId), gte(uxFindings.createdAt, cutoff)));

  const ruleRows = await db
    .select()
    .from(uxContractRules)
    .where(eq(uxContractRules.projectId, projectId));

  return detectUxImproverCandidates({
    now,
    findings: findingRows.map((r) => ({
      id: r.id,
      issueId: r.issueId,
      runId: r.runId,
      stage: r.stage,
      ruleId: r.ruleId,
      kind: r.kind,
      detail: r.detail,
      severity: r.severity,
      createdAt: r.createdAt,
    })),
    rules: ruleRows.map((r) => ({
      id: r.id,
      group: r.group,
      text: r.text,
      severity: r.severity,
      source: r.source,
      status: r.status,
      supersedesRuleId: r.supersedesRuleId,
      evidenceIssueIds: Array.isArray(r.evidenceIssueIds) ? (r.evidenceIssueIds as string[]) : [],
      orderIndex: r.orderIndex,
      updatedAt: r.updatedAt,
    })),
  });
}

function unionEvidence(existing: unknown, incoming: string[]): string[] {
  const base = Array.isArray(existing) ? (existing as string[]) : [];
  const out = [...base];
  for (const id of incoming) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * Writes the selected candidates. `add`/`strengthen` land at status `proposed`
 * with `source='learned'`; `retire` withdraws a stale proposal. Nothing here
 * touches an active rule's status — that is the human's move in the inbox.
 *
 * `keys` MAY be empty: every call also runs the evidence-refresh pass below, so
 * a run whose candidates were all refuted still keeps the inbox's evidence
 * current. That is why the improver prompt tells the agent to call this at the
 * end of every run rather than only when something survived.
 */
export async function applyUxImproverProposals(
  projectId: string,
  keys: string[],
  now: Date = new Date(),
): Promise<{ outcomes: UxImproverProposalOutcome[]; report: UxImproverReport }> {
  const report = await loadUxImproverReport(projectId, now);
  const byKey = new Map(report.candidates.map((c) => [c.key, c]));
  const outcomes: UxImproverProposalOutcome[] = [];
  let mutated = false;

  const existing = await db
    .select()
    .from(uxContractRules)
    .where(eq(uxContractRules.projectId, projectId));

  // cm:guard This pass, not the `duplicate` branch below, is what keeps an inbox proposal's evidence current: once a proposal exists the detector REFUSES the gap as `already-proposed`, so it never reaches `candidates` and the duplicate branch never sees it again. Delete this and evidence freezes at whatever the first run happened to observe.
  for (const refusal of report.refused) {
    if (refusal.reason !== 'already-proposed' || !refusal.targetRuleId) continue;
    const target = existing.find((r) => r.id === refusal.targetRuleId);
    if (!target) continue;
    const merged = unionEvidence(target.evidenceIssueIds, refusal.evidenceIssueIds);
    if (merged.length === (target.evidenceIssueIds as string[]).length) continue;
    await db
      .update(uxContractRules)
      .set({ evidenceIssueIds: merged, updatedAt: now })
      .where(eq(uxContractRules.id, target.id));
    outcomes.push({
      key: `evidence:${target.id}`,
      action: 'evidence-refreshed',
      ruleId: target.id,
    });
    mutated = true;
  }

  for (const key of keys) {
    const candidate = byKey.get(key);
    if (!candidate) {
      outcomes.push({ key, action: 'unmatched', ruleId: null });
      continue;
    }

    if (candidate.kind === 'retire') {
      await db
        .update(uxContractRules)
        .set({ status: 'retired', updatedAt: now })
        .where(eq(uxContractRules.id, candidate.targetRuleId as string));
      outcomes.push({ key, action: 'retired', ruleId: candidate.targetRuleId });
      mutated = true;
      continue;
    }

    // cm:guard Re-running the improver must never queue a second proposal for a gap already in the inbox — the schedule fires on every cadence tick, so a duplicate here compounds weekly until a human clears it. Match by signature and union the evidence instead.
    const duplicate = existing.find(
      (r) =>
        r.status === 'proposed' &&
        r.source === 'learned' &&
        r.group === candidate.group &&
        (candidate.kind === 'strengthen'
          ? r.supersedesRuleId === candidate.targetRuleId
          : jaccard(normalizeTokens(r.text), normalizeTokens(candidate.text)) >=
            SIMILARITY_THRESHOLD),
    );
    if (duplicate) {
      const merged = unionEvidence(duplicate.evidenceIssueIds, candidate.evidenceIssueIds);
      await db
        .update(uxContractRules)
        .set({ evidenceIssueIds: merged, updatedAt: now })
        .where(eq(uxContractRules.id, duplicate.id));
      outcomes.push({ key, action: 'evidence-refreshed', ruleId: duplicate.id });
      mutated = true;
      continue;
    }

    const siblings = existing.filter((r) => r.group === candidate.group);
    const orderIndex =
      candidate.kind === 'strengthen'
        ? (siblings.find((r) => r.id === candidate.targetRuleId)?.orderIndex ?? 0)
        : Math.max(-1, ...siblings.map((r) => r.orderIndex)) + 1;

    const [inserted] = await db
      .insert(uxContractRules)
      .values({
        projectId,
        group: candidate.group,
        text: candidate.text,
        severity: candidate.severity,
        source: 'learned',
        status: 'proposed',
        evidenceIssueIds: candidate.evidenceIssueIds,
        supersedesRuleId: candidate.targetRuleId,
        orderIndex,
      })
      .returning();
    if (!inserted) throw new Error('ux-improver: insert returned no row');
    existing.push(inserted);
    outcomes.push({ key, action: 'proposed', ruleId: inserted.id });
    mutated = true;
  }

  // cm:edge protocol -> packages/core/src/projects/ux-contract-routes.ts — invariant #1: every path that mutates ux_contract_rules recompiles before returning, even when only `proposed` rows moved and the prose cannot have changed.
  if (mutated) await recompileAndPersistUxContract(projectId);

  return { outcomes, report };
}
