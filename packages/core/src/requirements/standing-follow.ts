/**
 * The words a requirement's act uses when a design or contract it follows has moved on: what the
 * signer does, and what doing it changes. Split from `standing.ts` to keep that file one read.
 */

import { type Said, say } from '@forge/contracts/said';

/** What a signer does about a pin that fell behind, in the words a BA reads: the design's own name and revision. */
export function updateToApprovedAct(
  designs: readonly { title: string; approved: number }[],
  contracts: readonly { contract: string; current: string }[],
): Said {
  return say('standing.acts', {
    acts: [
      ...designs.map((p) => say('standing.act.updateToDesign', { design: p.title, r: p.approved })),
      ...contracts.map((p) =>
        say('standing.act.updateToContract', { contract: p.contract, v: p.current }),
      ),
    ],
  });
}

/** What pressing "update" really does (`repin.ts`): a new baseline of the same agreed revision pins the newer ones; nothing in the wording or criteria is rewritten. */
export function updateToApprovedEffect(
  designs: readonly { title: string; approved: number }[],
  contracts: readonly { contract: string; current: string }[],
): Said {
  return say('standing.effect.follow', {
    names: [
      ...designs.map((p) => say('standing.effect.designAt', { title: p.title, r: p.approved })),
      ...contracts.map((p) =>
        say('standing.effect.contractAt', { contract: p.contract, v: p.current }),
      ),
    ],
  });
}

/** A node a live criterion traces that a newer approved design removed or renamed (`auto-follow.ts:tracedStepChanges`). */
export interface TracedChange {
  code: string;
  flow: string;
  /** The design's own name, as the stale pin names it. */
  title: string;
  approved: number;
  /** The step id, or `from>to` for an edge. */
  node: string;
  change: 'removed' | 'renamed';
}

const unique = (xs: readonly string[]) => [...new Set(xs)];

/** What the assistant owes when an approved design changed what criteria trace: revise them, named by the first design that did. */
export function reviseForDesignAct(changes: readonly TracedChange[]): Said {
  const [first] = changes;
  if (!first) throw new Error('reviseForDesignAct: called with no traced change');
  const same = changes.filter((c) => c.flow === first.flow);
  return say('standing.act.reviseForDesign', {
    codes: unique(same.map((c) => c.code)).join(', '),
    design: first.title,
    r: first.approved,
    steps: unique(same.map((c) => `${c.node} ${c.change}`)).join(', '),
  });
}
