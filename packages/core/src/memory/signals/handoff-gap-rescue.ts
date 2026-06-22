import type { CandidateSignal } from './reopen-loop.js';
import { getHandoffsForRun } from './queries.js';

/** Returns true if the payload object has a non-empty unknowns/knownLimitations array. */
function hasOpenItems(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  const unknowns = Array.isArray(p['unknowns']) ? p['unknowns'] : [];
  const limitations = Array.isArray(p['knownLimitations']) ? p['knownLimitations'] : [];
  return unknowns.length > 0 || limitations.length > 0;
}

/**
 * Detect cases where a later stage patches gaps left by an earlier stage.
 * Heuristic: if step N's handoff has unknowns/knownLimitations and step N+1
 * exists (meaning the pipeline continued despite the gap), that's a rescue.
 * Signal key: `handoff_gap:<fromStep>-><toStep>`.
 * Acceptable for v1: silently absent when stages skip handoff.
 */
export async function extractHandoffGapRescue(
  runId: string,
  _projectId: string,
  issueId: string,
): Promise<CandidateSignal[]> {
  const handoffs = await getHandoffsForRun(runId);
  if (handoffs.length < 2) return [];

  const signals: CandidateSignal[] = [];
  for (let i = 0; i < handoffs.length - 1; i++) {
    const current = handoffs[i];
    const next = handoffs[i + 1];
    if (!current || !next) continue;
    if (!hasOpenItems(current.payload)) continue;

    const fromStep = current.step ?? 'unknown';
    const toStep = next.step ?? 'unknown';
    signals.push({
      signalType: 'handoff_gap_rescue',
      signalKey: `handoff_gap:${fromStep}->${toStep}`,
      summary: `Stage "${fromStep}" left open items that stage "${toStep}" had to address — a recurring stage-gap pattern.`,
      evidence: { runId, issueId, at: new Date().toISOString() },
    });
  }
  return signals;
}
