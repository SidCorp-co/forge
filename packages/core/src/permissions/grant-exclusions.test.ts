import { describe, expect, it } from 'vitest';
import { runWithPatScope } from '../credentials/pat-scope.js';
import { holds } from './can.js';

const facts = {
  projectId: '00000000-0000-4000-8000-000000000001',
  role: 'admin' as const,
  grants: [],
};
const token = (grant: string[]) => ({
  projectIds: null,
  tokenId: 't',
  grant,
  scopes: ['read', 'write'],
});

describe('an observer credential cannot write or decide the design (REQ-17 BC-20)', () => {
  it('a token naming workflow-observations.write holds it and not workflow-designs.write', () => {
    runWithPatScope(token(['*', 'workflow-observations.write']), () => {
      expect(holds(facts, 'workflow-observations.write')).toBe(true);
      expect(holds(facts, 'workflow-designs.write')).toBe(false);
      expect(holds(facts, 'workflow-designs.approve')).toBe(false);
    });
  });

  it('a token not naming it writes the design and observes nothing', () => {
    runWithPatScope(token(['*', 'workflow-designs.approve']), () => {
      expect(holds(facts, 'workflow-designs.write')).toBe(true);
      expect(holds(facts, 'workflow-designs.approve')).toBe(true);
      expect(holds(facts, 'workflow-observations.write')).toBe(false);
    });
  });

  it('a session holds both by its role', () => {
    expect(holds(facts, 'workflow-observations.write')).toBe(true);
    expect(holds(facts, 'workflow-designs.write')).toBe(true);
  });
});
