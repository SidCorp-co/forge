/**
 * The words a requirement's act uses when a design or contract it follows has moved on: what the
 * signer does, and what doing it changes. Split from `standing.ts` to keep that file one read.
 */

import type {
  RequirementAttentionGroup,
  RequirementWaitingOn,
} from '@forge/contracts/requirements';
import { type Said, say } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import { whoOwes } from '@forge/contracts/who-owes';
import type { StandingInput } from './standing.js';
import type { RequirementViewer } from './standing-draft.js';

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

/** A node a live criterion traces that a newer approved design removed or renamed (`follow-reads.ts:tracedStepChanges`). */
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

/**
 * A requirement pinned behind an approved design or a current contract: re-pinning it to what was
 * approved is routine, the master's unless the project's gate asks a person (`whoOwes`, ISS-1068);
 * a person's, it is the signer's Needs you where the viewer signs off, else waits on its owner.
 */
export function pinBehindTurn(
  input: Pick<StandingInput, 'stalePins' | 'staleContractPins' | 'owner' | 'owed'>,
  viewer: RequirementViewer | null,
): { group: RequirementAttentionGroup; waitingOn: RequirementWaitingOn } | null {
  if (input.stalePins.length === 0 && input.staleContractPins.length === 0) return null;
  const says = {
    act: updateToApprovedAct(input.stalePins, input.staleContractPins),
    rule: say('requirements.rule.pinBehind'),
    effect: updateToApprovedEffect(input.stalePins, input.staleContractPins),
  };
  if (input.owed && whoOwes('requirement.repin', input.owed).by === 'master') {
    return {
      group: 'waiting',
      waitingOn: waitingOn('agent', { who: say('standing.who.master'), ...says }),
    };
  }
  if (viewer?.canSignOff) {
    return {
      group: 'needs_you',
      waitingOn: waitingOn('you', { who: say('standing.who.you'), ...says }),
    };
  }
  const owner = input.owner?.kind === 'human' ? input.owner.name : null;
  const who = owner ? say('standing.who.named', { name: owner }) : say('standing.who.baOrOwner');
  return { group: 'waiting', waitingOn: waitingOn('person', { who, ...says }) };
}
