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
