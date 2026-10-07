/**
 * One line of what a design revision changed, for the revisions list a person decides from: the diff
 * the canvas draws (`design-diff.ts`) read against the revision before, steps named by their title.
 */

import type { RevisionChanges } from '@forge/contracts/workflows';
import { designDiff } from './design-diff.js';
import { readStoredWorkflow } from './schema.js';

export function revisionChangesOf(before: unknown, after: unknown): RevisionChanges | null {
  if (before === undefined) return null;
  const was = readStoredWorkflow(before);
  const now = readStoredWorkflow(after);
  if (!was || !now) return null;
  const diff = designDiff(was, now);
  const titleOf = new Map([...was.steps, ...now.steps].map((s) => [s.id, s.title ?? s.id]));
  const steps: RevisionChanges['steps'] = { added: [], removed: [], changed: [] };
  for (const [id, mark] of diff.steps) steps[mark].push(titleOf.get(id) ?? id);
  const edges = { added: 0, removed: 0, changed: 0 };
  for (const mark of diff.edges.values()) edges[mark] += 1;
  return { steps, edges };
}
