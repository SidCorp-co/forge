import { describe, expect, it } from 'vitest';
import { describeRewrite, noOpSentence } from './close-substitution.js';

const PROJECT = '11111111-2222-3333-4444-555555555555';

describe('noOpSentence', () => {
  it('says the plain thing where nothing was substituted', () => {
    expect(
      noOpSentence({
        projectId: PROJECT,
        requested: 'developed',
        parked: 'developed',
        final: 'developed',
      }),
    ).toBe('issue already in status developed');
  });

  it('names both statuses when the release gate rewrote the close', () => {
    const sentence = noOpSentence({
      projectId: PROJECT,
      requested: 'closed',
      parked: 'closed',
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
      parked: 'closed',
      final: 'awaiting_release',
    });

    expect(sentence).toContain('release gate');
    expect(sentence).toContain('already in status `awaiting_release`');
  });

  it('carries both routes to `closed`, with this project id in them', () => {
    const sentence = noOpSentence({
      projectId: PROJECT,
      requested: 'closed',
      parked: 'closed',
      final: 'awaiting_release',
    });

    expect(sentence).toContain(`/api/projects/${PROJECT}/release-batches`);
    expect(sentence).toContain(`/api/projects/${PROJECT}/release-records`);
  });

  it('names the driver rather than the release gate when a park was rewritten', () => {
    const sentence = noOpSentence({
      projectId: PROJECT,
      requested: 'waiting',
      parked: 'needs_info',
      final: 'needs_info',
    });

    expect(sentence).toContain('`waiting`');
    expect(sentence).toContain('`needs_info`');
    expect(sentence).not.toContain('release gate');
  });

  it('reports the release gate where a park rewrite and a close rewrite both fired', () => {
    const sentence = noOpSentence({
      projectId: PROJECT,
      requested: 'waiting',
      parked: 'needs_info',
      final: 'awaiting_release',
    });

    expect(sentence).toContain('`waiting`');
    expect(sentence).toContain('`awaiting_release`');
    expect(sentence).toContain('release gate');
  });
});

describe('describeRewrite (ISS-1365)', () => {
  it('answers null where the status stored is the one asked for', () => {
    expect(
      describeRewrite({
        requested: 'developed',
        parked: 'developed',
        final: 'developed',
        sentKind: null,
        storedKind: null,
      }),
    ).toBeNull();
  });

  it('names the driver and says the kind it kept', () => {
    const said = describeRewrite({
      requested: 'waiting',
      parked: 'needs_info',
      final: 'needs_info',
      sentKind: 'needs_decision',
      storedKind: 'needs_decision',
    });

    expect(said).toMatchObject({ rule: 'autonomous_driver', stored: 'needs_info' });
    expect(said?.detail).toContain('`waiting` was stored as `needs_info`');
    expect(said?.detail).toContain('`needs_decision` is kept');
  });

  it('names the release gate where it moved the target after the driver', () => {
    const said = describeRewrite({
      requested: 'closed',
      parked: 'closed',
      final: 'awaiting_release',
      sentKind: null,
      storedKind: null,
    });

    expect(said).toMatchObject({ rule: 'release_gate', requested: 'closed' });
    expect(said?.detail).not.toContain('waitingKind');
  });

  it('says a kind the row did not keep was not kept, naming what it stores', () => {
    const said = describeRewrite({
      requested: 'waiting',
      parked: 'needs_info',
      final: 'needs_info',
      sentKind: 'needs_decision',
      storedKind: null,
    });

    expect(said?.waitingKind).toEqual({ sent: 'needs_decision', stored: null });
    expect(said?.detail).toContain('`needs_decision` was not kept; the row stores none');
  });
});
