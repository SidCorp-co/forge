import type { AgentSessionSummary } from './api';

/**
 * ISS-40 PR-E — render a tooltip for a queued session that was skipped by
 * one of the dispatcher's 4 gating layers. Returns null when the session
 * has no recognised gating reason (caller falls back to the generic
 * "waiting for worker" copy).
 *
 * Pure function so it can be unit-tested in isolation; rendering happens in
 * `agent-sidebar.tsx`.
 */
export function renderGatedTooltip(s: AgentSessionSummary): string | null {
  const reason = s.failureReason;
  if (!reason) return null;
  switch (reason) {
    case 'issue_busy':
      return 'Another session is running on this issue — wait for it to finish';
    case 'project_full':
      return 'Project is at max parallel issues';
    case 'runner_full':
      return 'Runner slots are full — waiting for one to free up';
    case 'waiting_on_dep': {
      const meta = (s.metadata ?? {}) as Record<string, unknown>;
      const waitingOn = Array.isArray(meta.waitingOn) ? (meta.waitingOn as Array<unknown>) : [];
      const labels = waitingOn
        .map((row) => {
          if (!row || typeof row !== 'object') return null;
          const seq = (row as { issSeq?: number }).issSeq;
          return typeof seq === 'number' ? `ISS-${seq}` : null;
        })
        .filter((v): v is string => v !== null);
      if (labels.length === 0) return 'Waiting on dependency issue to complete';
      return `Waiting on ${labels.join(', ')} to complete`;
    }
    default:
      return null; // forward-compat: unknown reasons fall back to default
  }
}
