import { describe, expect, it } from 'vitest';
import {
  commitmentsRefusal,
  commitmentsSetterOf,
  providerWriterRefusal,
  type RevisionBy,
} from './provider-writer-rules.js';

const P = '11111111-1111-4111-8111-111111111111';
const agent = (role: Parameters<typeof providerWriterRefusal>[0]['role']) => ({
  userId: 'agent-1',
  agency: 'agent' as const,
  role,
});
const person = (role: Parameters<typeof providerWriterRefusal>[0]['role']) => ({
  userId: 'person-1',
  agency: 'human' as const,
  role,
});

describe("a provider's interface and contract versions are written by its own agent or an admin", () => {
  it.each([
    ['its own agent as member', agent('member')],
    ['its own agent as admin', agent('admin')],
    ['a person holding admin', person('admin')],
  ])('takes %s', (_who, facts) => {
    expect(providerWriterRefusal(facts, P, 'INTERFACE_WRITER_NOT_PROJECT')).toBeNull();
  });

  it.each([
    [
      "another project's agent (no role here)",
      agent(null),
      /holds no role.*not this project's own agent/,
    ],
    ['an agent holding viewer', agent('viewer'), /holds viewer/],
    ['a person holding member', person('member'), /acts as a person holding member/],
    ['a person with no role', person(null), /acts as a person holding no role/],
  ])('refuses %s by name', (_who, facts, why) => {
    for (const code of ['INTERFACE_WRITER_NOT_PROJECT', 'CONTRACT_WRITER_NOT_PROVIDER'] as const) {
      const r = providerWriterRefusal(facts, P, code);
      expect(r).toMatchObject({ code });
      expect(r?.detail).toMatch(why);
    }
  });
});

const rev = (
  revision: number,
  deprecationNoticeDays: number,
  agency: 'agent' | 'human',
): RevisionBy => ({
  revision,
  document: {
    commitments: { versioning: 'semver', deprecationNoticeDays, responseDays: { rfi: 5 } },
  },
  writtenBy: `${agency}-${revision}`,
  writtenAt: new Date(Date.UTC(2026, 9, revision)),
  agency,
});

describe('who set the commitment windows is read from the revisions, never from the document', () => {
  it('is the revision that last changed them, not the one that last wrote the interface', () => {
    expect(
      commitmentsSetterOf([rev(4, 30, 'agent'), rev(3, 30, 'human'), rev(2, 14, 'agent')]),
    ).toMatchObject({
      agency: 'human',
      revision: 3,
      userId: 'human-3',
    });
    expect(commitmentsSetterOf([rev(2, 14, 'agent'), rev(1, 30, 'human')])).toMatchObject({
      agency: 'agent',
      revision: 2,
    });
    expect(commitmentsSetterOf([])).toBeNull();
  });

  it("refuses an agent's write that moves windows a person set, and takes every other", () => {
    const byPerson = commitmentsSetterOf([rev(1, 30, 'human')]);
    const byAgent = commitmentsSetterOf([rev(1, 30, 'agent')]);
    const now = rev(1, 30, 'human').document;
    const moved = rev(2, 7, 'agent').document;
    expect(commitmentsRefusal({ agency: 'agent' }, byPerson, now, moved)).toMatchObject({
      code: 'COMMITMENTS_SET_BY_PERSON',
      path: '/commitments',
    });
    expect(commitmentsRefusal({ agency: 'agent' }, byPerson, now, now)).toBeNull();
    expect(commitmentsRefusal({ agency: 'agent' }, byAgent, now, moved)).toBeNull();
    expect(commitmentsRefusal({ agency: 'human' }, byPerson, now, moved)).toBeNull();
    expect(commitmentsRefusal({ agency: 'agent' }, null, undefined, moved)).toBeNull();
  });
});
