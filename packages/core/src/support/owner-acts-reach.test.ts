import { DECISION_ACT_NAMES } from '@forge/contracts/needs-you-decisions';
import { SUPPORT_FORGE_ACTS, supportForgeActRequestSchema } from '@forge/contracts/support-channel';
import { describe, expect, it } from 'vitest';
import { CHAT_DOOR_OF_DECISION, doorOfDecision } from './owner-acts-reach.js';
import { DECISION_FORGE_ACTS } from './owner-decision-acts.js';
import { WORK_ACT_CARDS } from './work-cards.js';

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
      'requirement.repin',
    ]);
    expect(doorOfDecision('preview.approve')).toEqual({ tool: null, page: "the preview's page" });
    expect(doorOfDecision('question.close')).toBeNull();
  });
});

// ISS-1441 (FB-838): the owner's "ok" to a parked production deploy had only the release's page; the
// room now confirms it as him, and its card teaches the act rather than a button.
describe("the production deploy's confirm the owner gives in chat (ISS-1441)", () => {
  it('is an owner act from chat, and the card names it and its refusals', () => {
    expect(doorOfDecision('release.confirmDeploy')).toEqual({
      tool: 'owner_forge_act',
      acts: ['release.confirmDeploy'],
    });
    expect(SUPPORT_FORGE_ACTS).toContain('release.confirmDeploy');
    const card = JSON.stringify(WORK_ACT_CARDS.owner_forge_act);
    expect(card).toContain('act: release.confirmDeploy, item: the version');
    expect(card).toContain('SUPPORT_CONFIRM_DEPLOY_NOT_WAITING');
    expect(card).not.toMatch(/type confirm|press (the )?confirm/i);
  });
});

// ISS-1357: a room agent reads, before it calls, how a rule write is refused for an account that may
// not write the project (`owner-rule-act.ts:writeOwnerRule`, its permission check's own code).
describe('the rule write the owner rules in chat (ISS-1357)', () => {
  it('names its refusal for an account without project.write in the field and the card it reads', () => {
    expect(supportForgeActRequestSchema.shape.rule.description).toContain(
      'refused PERMISSION_FORBIDDEN',
    );
    expect(WORK_ACT_CARDS.owner_forge_act.practice.join(' ')).toContain(
      'without project.write is refused PERMISSION_FORBIDDEN',
    );
  });
});

// ISS-1449 (FB-848): the owner's ruling to remove a project had no act, so the room sent him to a page;
// it is an owner act now, and its card teaches what it does, its refusals and what it leaves alone.
describe('the project archive the owner rules in chat (ISS-1449)', () => {
  it('is a declared owner act, and the card names it, its refusals and what it leaves alone', () => {
    expect(SUPPORT_FORGE_ACTS).toContain('project.archive');
    const card = JSON.stringify(WORK_ACT_CARDS.owner_forge_act);
    expect(card).toContain('act: project.archive, item: the project’s own slug');
    expect(card).toContain('SUPPORT_ARCHIVE_RELEASE_IN_FLIGHT');
    expect(card).toContain('SUPPORT_ARCHIVE_DEPLOY_AWAITING_CONFIRM');
    expect(card).toContain('repository and site are left as they are');
  });
});
