// The public-face rule (REQ-12 BC-13, ISS-817): every kernel, domain, read-model, adapter and door
// module has an index.ts, and a platform module, a leaf, may go without one.

import { describe, expect, it } from 'vitest';
import { faceFindings, RULES } from './module-shape.mjs';

const modules = {
  '(root)': { kind: 'door' },
  jobs: { kind: 'kernel' },
  issues: { kind: 'domain' },
  me: { kind: 'read-model' },
  'integrations/github': { kind: 'adapter' },
  'integration-door': { kind: 'door' },
  lib: { kind: 'platform' },
};

describe('faceFindings', () => {
  it('is empty when every non-platform module has an index.ts', () => {
    expect(faceFindings(modules, () => true)).toEqual([]);
  });

  it('names the module, its kind and the valid shape when an index.ts is missing', () => {
    const [f, ...rest] = faceFindings(modules, (p) => p !== 'me');
    expect(rest).toEqual([]);
    expect(f.rule).toBe('face');
    expect(f.module).toBe('me');
    expect(f.detail).toContain('me is a read-model module with no index.ts');
    expect(f.detail).toContain('packages/core/src/me/index.ts');
  });

  it('refuses each non-platform kind', () => {
    const names = faceFindings(modules, () => false).map((f) => f.module);
    expect(names).toEqual(['jobs', 'issues', 'me', 'integrations/github', 'integration-door']);
  });

  it('leaves a platform module and the root exempt', () => {
    expect(
      faceFindings({ lib: { kind: 'platform' }, '(root)': { kind: 'door' } }, () => false),
    ).toEqual([]);
  });

  it('is a rule the tally counts', () => {
    expect(RULES).toContain('face');
  });
});
