// @direct-test-of packages/core/src/lessons-ports.ts
// @direct-test-of packages/core/src/steward/lessons-anchor.ts
// ISS-1251 c4: ten unrelated lessons sat on `card:support.member`. Round 1's anchor prompt offered no
// cards and gave that one as its example; the steward copied it. A card anchor is now taken only where
// the step offered it (or a confusion's raiser named it), the offer ranks a card by the words it alone
// shares with the lesson, and the prompts hold no real anchor to copy.

import { LESSON_ANCHOR_SHAPE } from '@forge/contracts/lessons';
import { describe, expect, it } from 'vitest';

const { nearestCards } = await import('../lessons-ports.js');
const { anchorPrompt, recheckPrompt } = await import('./lessons-lifecycle.js');
const { takenAnchor } = await import('./lessons-anchor.js');

const card = (id: string, purpose: string, when = 'an agent works an issue in a project') => ({
  id,
  purpose,
  situations: [{ when, do: 'call it for the project and the issue' }],
});

describe('the cards a step offers, and the anchor it takes', () => {
  it('offers the card sharing the lesson’s rare words, never one sharing only words every card says', () => {
    const cards = [
      card(
        'support.member',
        'Keeps a member’s roles for the project, the issue, the agent and the room record.',
        'an agent works an issue, a project, a room, a record, a member and a role',
      ),
      card('beta.link', 'Builds the link a ported beta issue carries to its web host.'),
      card('releases.get', 'Reads one release of the project.'),
    ];
    const near = nearestCards(
      cards,
      'For beta issues in the project, an agent generates links on the beta web host.',
      2,
    );
    // the member card shares only words every card says, so it is not offered at all
    expect(near.map((c) => c.id)).toEqual(['beta.link']);
  });

  it('takes a card anchor only where it was offered or the raiser named it, any other anchor as written', () => {
    const offered = [{ id: 'support.reply', purpose: 'Posts your answer.' }];
    expect(takenAnchor('card:support.reply', offered)).toBe('card:support.reply');
    expect(takenAnchor('card:support.member', offered)).toBeNull();
    expect(
      takenAnchor('card:support.member', offered, 'The right anchor: card:support.member.'),
    ).toBe('card:support.member');
    expect(takenAnchor('packages/core/src/beta-port/markers.ts:betaIssueLink', [])).toBe(
      'packages/core/src/beta-port/markers.ts:betaIssueLink',
    );
    expect(takenAnchor('REQ-12 BC-3', [])).toBe('REQ-12 BC-3');
    expect(takenAnchor('card:79bf44c4', [])).toBeNull();
    expect(takenAnchor(null, offered)).toBeNull();
  });

  it('says no real anchor an answer could copy, and asks the re-check whether the anchor is right', () => {
    const lesson = {
      id: 'l',
      number: 55,
      sentence: 'Link beta issues to the beta web host.',
      anchor: 'card:support.member',
      invalidBy: 'ISS-1251 changed card:support.member',
      appliedCount: 0,
      failures: [],
    };
    const offered = [{ id: 'beta.link', purpose: 'Builds the beta link.' }];
    expect(LESSON_ANCHOR_SHAPE).not.toMatch(/packages\/core\/src\/[a-z-]+\//);
    expect(anchorPrompt(lesson, offered)).not.toMatch(/e\.g\. `card:/);
    const recheck = recheckPrompt(lesson, offered);
    expect(recheck).toContain('First ask whether its anchor is what the lesson is about at all');
    expect(recheck).toContain('- card:beta.link: Builds the beta link.');
  });
});
