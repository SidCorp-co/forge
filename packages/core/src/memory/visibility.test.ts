import { describe, expect, it } from 'vitest';
import { ROLE_RANK, allowedRoleVisibilityPairs, isVisibleTo } from './visibility.js';

describe('memory/visibility — isVisibleTo', () => {
  it('visibility=all returns true regardless of viewer', () => {
    expect(isVisibleTo('ceo', 'all', [])).toBe(true);
    expect(isVisibleTo('ceo', 'all', ['anything'])).toBe(true);
    expect(isVisibleTo('dev', 'all', ['unknown-role'])).toBe(true);
  });

  it('down: a senior memory is visible to a more junior viewer', () => {
    expect(isVisibleTo('ceo', 'down', ['dev'])).toBe(true);
    expect(isVisibleTo('cto', 'down', ['qa'])).toBe(true);
  });

  it('down: a junior memory is NOT visible to a senior viewer', () => {
    expect(isVisibleTo('dev', 'down', ['ceo'])).toBe(false);
    expect(isVisibleTo('qa', 'down', ['cto'])).toBe(false);
  });

  it('up: a junior memory is visible to a senior viewer', () => {
    expect(isVisibleTo('dev', 'up', ['ceo'])).toBe(true);
    expect(isVisibleTo('qa', 'up', ['cto'])).toBe(true);
  });

  it('up: a senior memory is NOT visible to a junior viewer', () => {
    expect(isVisibleTo('ceo', 'up', ['dev'])).toBe(false);
  });

  it('same: only matches viewers holding the same role', () => {
    expect(isVisibleTo('dev', 'same', ['dev'])).toBe(true);
    expect(isVisibleTo('dev', 'same', ['ceo'])).toBe(false);
    expect(isVisibleTo('dev', 'same', ['qa', 'dev'])).toBe(true);
  });

  it('unknown viewer roles are dropped; an empty/unknown set hides the memory', () => {
    expect(isVisibleTo('dev', 'down', ['intern'])).toBe(false);
    expect(isVisibleTo('dev', 'same', ['intern'])).toBe(false);
    expect(isVisibleTo('dev', 'up', ['intern'])).toBe(false);
  });

  it('mixed known + unknown viewer roles still resolve via the known ones', () => {
    expect(isVisibleTo('ceo', 'down', ['intern', 'dev'])).toBe(true);
    expect(isVisibleTo('dev', 'up', ['unknown', 'ceo'])).toBe(true);
  });

  it('rank ordering: ceo is most senior, devops least', () => {
    expect(ROLE_RANK.ceo).toBeLessThan(ROLE_RANK.cto);
    expect(ROLE_RANK.cto).toBeLessThan(ROLE_RANK.dev);
    expect(ROLE_RANK.dev).toBeLessThan(ROLE_RANK.devops);
  });
});

describe('memory/visibility — allowedRoleVisibilityPairs', () => {
  it('always includes (*, all)', () => {
    const pairs = allowedRoleVisibilityPairs(['dev']);
    const allPairs = pairs.filter((p) => p.visibility === 'all').map((p) => p.role);
    expect(allPairs).toEqual(expect.arrayContaining(['ceo', 'cto', 'dev', 'qa']));
  });

  it('a dev viewer sees ceo memories tagged "down"', () => {
    const pairs = allowedRoleVisibilityPairs(['dev']);
    expect(pairs).toContainEqual({ role: 'ceo', visibility: 'down' });
  });

  it('a dev viewer does NOT see ceo memories tagged "up"', () => {
    const pairs = allowedRoleVisibilityPairs(['dev']);
    expect(pairs).not.toContainEqual({ role: 'ceo', visibility: 'up' });
  });

  it('a ceo viewer sees dev memories tagged "up" but not "down"', () => {
    const pairs = allowedRoleVisibilityPairs(['ceo']);
    expect(pairs).toContainEqual({ role: 'dev', visibility: 'up' });
    expect(pairs).not.toContainEqual({ role: 'dev', visibility: 'down' });
  });

  it('an empty viewer set yields only `(*, all)` pairs', () => {
    const pairs = allowedRoleVisibilityPairs([]);
    expect(pairs.every((p) => p.visibility === 'all')).toBe(true);
  });
});
