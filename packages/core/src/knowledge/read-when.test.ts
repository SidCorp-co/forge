import { describe, expect, it } from 'vitest';
import { parseReadWhen } from './service.js';

describe('parseReadWhen — happy (criteria 19, 20)', () => {
  it('parses a condition naming a master verb', () => {
    expect(parseReadWhen({ verbs: ['triage'] })).toEqual({
      ok: true,
      value: { verbs: ['triage'] },
    });
  });

  it('parses a condition naming a board status', () => {
    expect(parseReadWhen({ statuses: ['open'] })).toEqual({
      ok: true,
      value: { statuses: ['open'] },
    });
  });

  it('parses a condition naming both axes', () => {
    expect(parseReadWhen({ verbs: ['dispatch', 'fold'], statuses: ['open', 'draft'] })).toEqual({
      ok: true,
      value: { verbs: ['dispatch', 'fold'], statuses: ['open', 'draft'] },
    });
  });

  it('parses undefined and null alike as "no condition"', () => {
    expect(parseReadWhen(undefined)).toEqual({ ok: true, value: null });
    expect(parseReadWhen(null)).toEqual({ ok: true, value: null });
  });

  it('accepts every declared master verb', () => {
    for (const verb of ['triage', 'dispatch', 'fold', 'judge', 'release', 'park']) {
      expect(parseReadWhen({ verbs: [verb] }).ok).toBe(true);
    }
  });
});

describe('parseReadWhen — negative and boundary (criteria 24-27)', () => {
  it('is not an object at all', () => {
    const parsed = parseReadWhen('triage');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('readWhen');
  });

  it('refuses a verb outside the declared set, naming the field and every valid verb (criterion 24)', () => {
    const parsed = parseReadWhen({ verbs: ['deploy'] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.field).toBe('verbs');
      expect(parsed.refusal.message).toContain('deploy');
      for (const verb of ['triage', 'dispatch', 'fold', 'judge', 'release', 'park']) {
        expect(parsed.refusal.message).toContain(verb);
      }
    }
  });

  it('refuses a value that is not an issue status, naming the field and every valid status (criterion 25)', () => {
    const parsed = parseReadWhen({ statuses: ['done'] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal.field).toBe('statuses');
      expect(parsed.refusal.message).toContain('done');
      expect(parsed.refusal.message).toContain('open');
      expect(parsed.refusal.message).toContain('closed');
    }
  });

  it.each(['glob', 'globs', 'paths', 'files', 'pattern'])(
    'refuses a condition carrying `%s`, saying a condition is a verb or a board state and never a file glob (criterion 26)',
    (key) => {
      const parsed = parseReadWhen({ [key]: ['src/**/*.ts'] });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.refusal.field).toBe(key);
        expect(parsed.refusal.message).toContain('file glob');
      }
    },
  );

  it('refuses a condition naming neither axis rather than storing one that matches nothing (criterion 27)', () => {
    const parsed = parseReadWhen({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.message).toContain('neither');
  });

  it('refuses an unrecognised key beside a valid axis', () => {
    const parsed = parseReadWhen({ verbs: ['triage'], scope: 'repo' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('scope');
  });

  it('refuses `verbs` sent as a single string rather than an array', () => {
    const parsed = parseReadWhen({ verbs: 'triage' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('verbs');
  });

  it('refuses `statuses` sent as a single string rather than an array', () => {
    const parsed = parseReadWhen({ statuses: 'open' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('statuses');
  });

  it('refuses an empty `verbs` array — it matches no verb, the same defect as naming neither axis', () => {
    const parsed = parseReadWhen({ verbs: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('verbs');
  });

  it('refuses an empty `statuses` array', () => {
    const parsed = parseReadWhen({ statuses: [] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('statuses');
  });

  it('refuses both axes present but both empty', () => {
    const parsed = parseReadWhen({ verbs: [], statuses: [] });
    expect(parsed.ok).toBe(false);
  });

  it('refuses a non-string element inside `verbs`', () => {
    const parsed = parseReadWhen({ verbs: [42] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.refusal.field).toBe('verbs');
  });
});
