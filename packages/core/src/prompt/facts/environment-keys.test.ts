// ISS-1069 — the three `{{project:}}` keys that read `projects.environments`.
//
// Their own file rather than a longer `resolve.test.ts`, because what they are about is different
// from the rest of that resolver: the KEY NAMES are a contract with skill bodies in OTHER
// repositories, and no gate in this repo can see one. `test-urls`, `test-creds` and `test-notes`
// keep their spellings while the fields behind them move — rename one and a sentence disappears
// from an agent's prompt with nobody told, because an unresolved `{{project:<key>}}` renders as the
// empty string rather than failing.

import { describe, expect, it } from 'vitest';
import { normalizeEnvironments } from '../../projects/environments.js';
import { makeProjectResolver } from './resolve.js';

function resolver(raw: unknown) {
  return makeProjectResolver({
    baseBranch: 'main',
    liveBranch: 'production',
    releaseModel: 'promote',
    repoPath: '/repo',
    environments: normalizeEnvironments(raw),
    integrations: [],
  });
}

const FILLED = {
  preview: {
    url: 'https://staging.example.com',
    apiUrl: 'https://api.staging.example.com',
    urls: [{ label: 'Mailbox', url: 'https://mail.staging.example.com' }],
  },
  live: { url: 'https://app.example.com' },
  limits: 'The QA account reaches no other project.',
};

describe('{{project:test-urls}}', () => {
  it('renders both sides, each line labelled with the side it is on', () => {
    const out = resolver(FILLED)('test-urls') ?? '';
    expect(out).toContain('- Preview: https://staging.example.com');
    expect(out).toContain('- Preview API: https://api.staging.example.com');
    expect(out).toContain('- Preview (Mailbox): https://mail.staging.example.com');
    expect(out).toContain('- Live: https://app.example.com');
  });

  it('renders the live API line when the project declares one', () => {
    const out = resolver({ live: { url: 'https://app.x', apiUrl: 'https://api.app.x' } })(
      'test-urls',
    );
    expect(out).toBe('- Live: https://app.x\n- Live API: https://api.app.x');
  });

  it('renders nothing at all for a project that declares neither side', () => {
    expect(resolver(null)('test-urls')).toBeUndefined();
    expect(resolver({ preview: null, live: {} })('test-urls')).toBeUndefined();
  });

  it('renders only the live line for a one-box project whose preview is null', () => {
    expect(resolver({ preview: null, live: { url: 'https://app.x' } })('test-urls')).toBe(
      '- Live: https://app.x',
    );
  });

  it('labels an unlabelled preview row without an empty bracket', () => {
    const out = resolver({ preview: { urls: [{ url: 'https://mail.x' }] } })('test-urls');
    expect(out).toBe('- Preview: https://mail.x');
  });
});

describe('{{project:test-notes}} and {{project:test-creds}}', () => {
  it('renders `test-notes` from `environments.limits`', () => {
    expect(resolver(FILLED)('test-notes')).toBe('The QA account reaches no other project.');
  });

  it('renders nothing for `test-notes` where no limits are recorded', () => {
    expect(resolver({ limits: null })('test-notes')).toBeUndefined();
  });

  it('renders `test-creds` as a pointer at the new path and never a stored value', () => {
    const out =
      resolver({
        ...FILLED,
        testCredentials: [{ label: 'Admin', username: 'qa', password: 'pw' }],
      })('test-creds') ?? '';
    expect(out).toContain('environments.testCredentials');
    expect(out).not.toContain('previewDeploy');
    expect(out).not.toContain('pw');
    expect(out).not.toContain('qa');
  });

  it('leaves `production-branch` and an unreserved key answering their refusals', () => {
    expect(resolver(FILLED)('production-branch')).toContain('was retired');
    expect(resolver(FILLED)('deploy-notes')).toContain('forge_knowledge');
  });
});
