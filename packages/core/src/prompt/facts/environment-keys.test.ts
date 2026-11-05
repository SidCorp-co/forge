// What a judge is told about signing in as a testing actor (ISS-959): `forge-runner judge-login`
// signs in itself and hands back a session, so neither the always-on fact nor the QA guide may send a
// judge to a file holding the password, or to its fields.
// @direct-test-of packages/core/src/guides/qa-guide.ts

import { describe, expect, it } from 'vitest';
import { QA_GUIDE } from '../../guides/qa-guide.js';
import type { ProjectDocument } from '../../project-config/index.js';
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
