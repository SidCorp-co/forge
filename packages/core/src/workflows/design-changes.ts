/**
 * One line of what a design revision changed, for the revisions list a person decides from: the diff
 * the canvas draws (`design-diff.ts`) read against the revision before, steps named by their title.
 */

import type { RevisionChanges } from '@forge/contracts/workflows';
import { designDiff } from './design-diff.js';
import { readStoredWorkflow } from './schema.js';

const TYPE_WORDS: Record<string, string> = { ENTRY: 'Start', EXIT: 'End' };

/** What an approver calls a step: the label its card shows, else its title, else where the flow starts or ends; its id only when the design gives it nothing else. */
function stepName(s: {
  id: string;
  title?: string | undefined;
  node?: { type: string; label?: string | undefined } | undefined;
}): string {
  return s.node?.label ?? s.title ?? TYPE_WORDS[s.node?.type ?? ''] ?? s.id;
}

export function revisionChangesOf(before: unknown, after: unknown): RevisionChanges | null {
  if (before === undefined) return null;
  const was = readStoredWorkflow(before);
  const now = readStoredWorkflow(after);
  if (!was || !now) return null;
  const diff = designDiff(was, now);
  const titleOf = new Map([...was.steps, ...now.steps].map((s) => [s.id, stepName(s)]));
  const steps: RevisionChanges['steps'] = { added: [], removed: [], changed: [] };
  for (const [id, mark] of diff.steps) steps[mark].push(titleOf.get(id) ?? id);
  const edges = { added: 0, removed: 0, changed: 0 };
  for (const mark of diff.edges.values()) edges[mark] += 1;
  return { steps, edges };
}
