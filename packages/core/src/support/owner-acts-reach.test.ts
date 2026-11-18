import { DECISION_ACT_NAMES } from '@forge/contracts/needs-you-decisions';
import { SUPPORT_FORGE_ACTS } from '@forge/contracts/support-channel';
import { describe, expect, it } from 'vitest';
import { CHAT_DOOR_OF_DECISION, doorOfDecision } from './owner-acts-reach.js';
import { DECISION_FORGE_ACTS } from './owner-decision-acts.js';

// ISS-1299: every act the owner's Needs you can owe is reached from his word in chat, or named as
// one no door makes yet; the ecosystem link he gave full rights to is among the owner acts.

describe("the owner's acts from chat (ISS-1299)", () => {
  it('holds the membership acts and every Needs-you decision folded in', () => {
    expect(SUPPORT_FORGE_ACTS).toEqual(
      expect.arrayContaining([
        'membership.invite',
        'membership.accept',
        'membership.decline',
        'membership.leave',
        ...DECISION_FORGE_ACTS,
      ]),
    );
  });

  it('says for each Needs-you decision how a room makes it, and each owner act it names exists', () => {
    for (const act of DECISION_ACT_NAMES) {
      const door = CHAT_DOOR_OF_DECISION[act];
      expect(door, act).toBeDefined();
      if (door.tool === 'owner_forge_act') {
        for (const named of door.acts) expect(SUPPORT_FORGE_ACTS, act).toContain(named);
      }
    }
  });

  it('names the page for the decisions no door from chat makes yet, and nothing for a non-decision', () => {
    const pages = DECISION_ACT_NAMES.filter((a) => CHAT_DOOR_OF_DECISION[a].tool === null);
    expect(pages.sort()).toEqual([
      'contract.decide',
      'design.repin',
      'preview.approve',
      'release.confirmDeploy',
      'requirement.repin',
    ]);
    expect(doorOfDecision('release.confirmDeploy')).toEqual({
      tool: null,
      page: "the release's page (Confirm production deploy)",
    });
    expect(doorOfDecision('question.close')).toBeNull();
  });
});
