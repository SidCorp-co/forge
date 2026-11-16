// A module's tree read by an agent is a read of each term and rule it carries (ISS-1256): recorded as
// ISS-1251's read signal (`run_context_reaches`, `how` get), the one counter the tree's `reads` shows.

import type { ModuleTreeResponse } from '@forge/contracts/module-map';

/** The knowledge entries a tree hands its reader: its terms and rules, by slug and kind. */
export const knowledgeReadIn = (tree: ModuleTreeResponse) => [
  ...tree.branches.term.map((n) => ({ slug: n.ref, kind: 'glossary' })),
  ...tree.branches.rule.map((n) => ({ slug: n.ref, kind: 'rule' })),
];
