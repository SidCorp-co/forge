// What a judge is told about signing in as a testing actor (ISS-959): `forge-runner judge-login`
// signs in itself and hands back a session, so neither the always-on fact nor the QA guide may send a
// judge to a file holding the password, or to its fields.
// @direct-test-of packages/core/src/guides/qa-guide.ts
// @direct-test-of packages/core/src/project-config/cards.ts
// @direct-test-of packages/core/src/support/secret-link.ts

import { describe, expect, it } from 'vitest';
import { QA_GUIDE } from '../../guides/qa-guide.js';
import type { ProjectDocument } from '../../project-config/index.js';
import { slotSays } from '../../support/secret-link.js';
import { AFFORDANCE_CARDS } from './affordance-cards.js';
import { renderTestCreds } from './environment-keys.js';

const document = {
  environments: {
    dev: { tier: 'production', deployment: { mode: 'external' }, testing: 'dev' },
  },
} as unknown as ProjectDocument;

const told = {
  'the test-creds fact': renderTestCreds('p1', document) ?? '',
  'the QA guide': QA_GUIDE.body,
};

describe('a judge is told to sign in through judge-login and handed only a session', () => {
  for (const [where, text] of Object.entries(told)) {
    it(`${where} names judge-login's session files and never a file holding the value`, () => {
      expect(text).toContain('forge-runner judge-login <profile> <actor> --run <run>');
      expect(text).toContain('curl -H @<file>');
      expect(text).toContain('Playwright storage state');
      expect(text).toMatch(/never open, print or measure either file/);
      // the older-runner login-file amnesty ended once the box ran a runner whose judge-login hands
      // back a session (ISS-978); served text names no issue key (`guides/registry.test.ts`)
      expect(text).not.toContain('older box runner');
      expect(text).not.toContain('login file');
      expect(text).not.toMatch(/ISS-\d+/);
      for (const old of ['0600', 'field names', 'writes the value', 'writes that one secret']) {
        expect(text, `${where} still says "${old}"`).not.toContain(old);
      }
    });
  }

  it('says nothing where no environment names a testing profile', () => {
    expect(renderTestCreds('p1', null)).toBeUndefined();
  });
});

// REQ-80 BC-12 (ISS-1429): a run refused a protected variable asks a project admin for the ruling,
// once, naming the act and the environment; no text teaching around the refusal says to turn its
// protection off, which is what a room agent asked an owner for over 37 hours.
describe('a withheld variable is taught as a ruling to ask for, never protection to drop', () => {
  const taught = {
    'the variables fact': renderTestCreds('p1', document) ?? '',
    // ISS-1429 reopen: the situation left the proposals card, whose door could turn protection off
    'the transition card':
      AFFORDANCE_CARDS.find((c) => c.id === 'POST /api/issues/:id/transition')?.situations.find(
        (s) => /comes back withheld/.test(s.when),
      )?.do ?? '',
    "the room's note on a protected slot": slotSays(false, false, 'only a run … reads it'),
  };
  for (const [where, text] of Object.entries(taught)) {
    it(`${where} asks for the ruling once, naming the act and the environment`, () => {
      expect(text).toMatch(/ruling/);
      expect(text).toMatch(/once/);
      expect(text).toMatch(/naming the act and the environment/);
      expect(text).not.toMatch(/protection off|protected: false|unprotect|turn[^.]*protection/i);
    });
  }

  // ISS-1431: the room was told to have the ruling asked for, and nowhere it is given
  it("the room's note on a protected slot names where a project admin gives the ruling", () => {
    const note = slotSays(false, false, 'only a run … reads it');
    expect(note).toContain("on the issue's page (Production ruling)");
    expect(note).toContain(
      'support.owner_forge_act, act issue.rule_production, citing their message',
    );
  });
});
