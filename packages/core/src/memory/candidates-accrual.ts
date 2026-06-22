import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type MemoryCandidateSignalType, memoryCandidates } from '../db/schema.js';

export const CONFIDENCE_INIT = 0.3;
export const CONFIDENCE_INCREMENT = 0.15;
export const CONFIDENCE_CAP = 0.9;
export const GRADUATE_CONFIDENCE = 0.6;
export const GRADUATE_EVIDENCE_COUNT = 2;

export interface CandidateInput {
  signalType: string;
  signalKey: string;
  summary: string;
  evidence: { runId: string; issueId: string; at: string };
}

interface EvidenceRef {
  runId: string;
  issueId: string;
  at: string;
}

/**
 * Upsert a memory candidate row with confidence accrual.
 * Reads the existing row, merges evidence, increments confidence, then updates.
 * The pg-boss worker serialises calls per-queue, so read-modify-write is safe enough for v1.
 */
export async function upsertCandidate(
  projectId: string,
  candidate: CandidateInput,
): Promise<void> {
  const runId = candidate.evidence.runId;

  const [existing] = await db
    .select()
    .from(memoryCandidates)
    .where(
      and(
        eq(memoryCandidates.projectId, projectId),
        eq(memoryCandidates.signalType, candidate.signalType as MemoryCandidateSignalType),
        eq(memoryCandidates.signalKey, candidate.signalKey),
      ),
    )
    .limit(1);

  if (!existing) {
    await db.insert(memoryCandidates).values({
      projectId,
      signalType: candidate.signalType as MemoryCandidateSignalType,
      signalKey: candidate.signalKey,
      status: 'accruing',
      confidence: CONFIDENCE_INIT.toFixed(2),
      evidenceCount: 1,
      evidence: [candidate.evidence],
      summary: candidate.summary,
    });
    return;
  }

  // Skip if already in a terminal curator state — don't re-accrue.
  if (
    existing.status === 'accepted' ||
    existing.status === 'rejected' ||
    existing.status === 'promoted'
  )
    return;

  const existingEvidence = (Array.isArray(existing.evidence) ? existing.evidence : []) as EvidenceRef[];
  const alreadySeen = existingEvidence.some((e) => e.runId === runId);

  const newEvidence = alreadySeen ? existingEvidence : [...existingEvidence, candidate.evidence];
  const newEvidenceCount = alreadySeen ? existing.evidenceCount : existing.evidenceCount + 1;
  const oldConfidence = Number(existing.confidence);
  const newConfidence = alreadySeen
    ? oldConfidence
    : Math.min(CONFIDENCE_CAP, oldConfidence + CONFIDENCE_INCREMENT);

  const shouldGraduate =
    existing.status === 'accruing' &&
    newConfidence >= GRADUATE_CONFIDENCE &&
    newEvidenceCount >= GRADUATE_EVIDENCE_COUNT;

  await db
    .update(memoryCandidates)
    .set({
      confidence: newConfidence.toFixed(2),
      evidenceCount: newEvidenceCount,
      evidence: newEvidence,
      summary: candidate.summary,
      status: shouldGraduate ? 'graduated' : existing.status,
      graduatedAt: shouldGraduate ? sql`now()` : existing.graduatedAt,
      archivedAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(memoryCandidates.id, existing.id));
}
