import { describe, expect, it } from 'vitest';
import { deliveryLine, deliverySubject, statusWords } from './subject.js';

const issueKeys = new Map([['i-1', 'ISS-18']]);
const slugs = new Map([['p-1', 'hop']]);

describe('deliverySubject', () => {
  it('names the issue a single-record delivery references', () => {
    expect(
      deliverySubject({ members: 1, issueId: 'i-1', projectId: 'p-1' }, issueKeys, slugs),
    ).toEqual({
      kind: 'issue',
      key: 'ISS-18',
      id: 'i-1',
    });
  });

  it('names the project of a grouped delivery, never one member’s issue', () => {
    expect(
      deliverySubject({ members: 3, issueId: 'i-1', projectId: 'p-1' }, issueKeys, slugs),
    ).toEqual({
      kind: 'project',
      key: 'hop',
      id: 'p-1',
    });
  });

  it('falls to the project when the issue is gone, and to nothing when neither is known', () => {
    expect(
      deliverySubject({ members: 1, issueId: 'gone', projectId: 'p-1' }, issueKeys, slugs)?.kind,
    ).toBe('project');
    expect(
      deliverySubject({ members: 1, issueId: null, projectId: null }, issueKeys, slugs),
    ).toBeNull();
  });
});

describe('deliveryLine', () => {
  it('drops the key and its dash from the front of the title', () => {
    expect(
      deliveryLine('ISS-18 — Discharge flow moved to closed', 'issue_status_changed', 'ISS-18'),
    ).toBe('Discharge flow moved to closed');
  });

  it('keeps a sentence that runs on from the key', () => {
    expect(deliveryLine('ISS-5 is waiting on you — hop', 'issue_stranded', 'ISS-5')).toBe(
      'is waiting on you — hop',
    );
  });

  it('reads a raw status stored by an older emitter as words', () => {
    expect(
      deliveryLine('ISS-18 — Flow moved to awaiting_release', 'issue_status_changed', 'ISS-18'),
    ).toBe('Flow moved to awaiting release');
  });

  it('leaves a status it does not know as stored, and leaves other types alone', () => {
    expect(deliveryLine('X moved to sideways', 'issue_status_changed', null)).toBe(
      'X moved to sideways',
    );
    expect(deliveryLine('Y moved to awaiting_release', 'mention', null)).toBe(
      'Y moved to awaiting_release',
    );
  });

  it('keeps the whole title when it is nothing but the key, and when it does not open with it', () => {
    expect(deliveryLine('ISS-18', 'issue_stranded', 'ISS-18')).toBe('ISS-18');
    expect(deliveryLine('Retries rescued 4 failures', 'retry_rescue_threshold', 'hop')).toBe(
      'Retries rescued 4 failures',
    );
  });
});

describe('statusWords', () => {
  it('lower-cases the sentence-case label of a kernel status', () => {
    expect(statusWords('awaiting_release')).toBe('awaiting release');
    expect(statusWords('needs_info')).toBe('needs info');
  });
});
