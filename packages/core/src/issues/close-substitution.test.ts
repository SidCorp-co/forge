import { describe, expect, it } from 'vitest';
import { noOpSentence } from './close-substitution.js';

const PROJECT = '11111111-2222-3333-4444-555555555555';

describe('noOpSentence', () => {
  it('says the plain thing where nothing was substituted', () => {
    expect(
      noOpSentence({
        projectId: PROJECT,
        requested: 'in_progress',
        final: 'in_progress',
      }),
    ).toBe('issue already in status in_progress');
  });

  it('names both statuses when the release gate rewrote the close', () => {
    const sentence = noOpSentence({
      projectId: PROJECT,
      requested: 'closed',
      final: 'awaiting_release',
    });

    expect(sentence).toContain('`closed`');
    expect(sentence).toContain('`awaiting_release`');
    expect(sentence).not.toBe('issue already in status awaiting_release');
  });

  it('says the issue is not in the status the caller asked for', () => {
    const sentence = noOpSentence({
      projectId: PROJECT,
      requested: 'closed',
      final: 'awaiting_release',
    });

    expect(sentence).toContain('release gate');
    expect(sentence).toContain('already in status `awaiting_release`');
  });

  it('carries both routes to `closed`, with this project id in them', () => {
    const sentence = noOpSentence({
      projectId: PROJECT,
      requested: 'closed',
      final: 'awaiting_release',
    });

    expect(sentence).toContain(`/api/projects/${PROJECT}/release-batches`);
    expect(sentence).toContain(`/api/projects/${PROJECT}/release-records`);
  });
});
