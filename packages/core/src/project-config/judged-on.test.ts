// `delivery.judgedOn` names the project's testing environment (REQ-36 BC-18): one it declares, and
// never production, since a release is proven there before it reaches production. Kept apart from
// `environments.<name>.testing`, which still names a testing profile.

import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { describe, expect, it } from 'vitest';
import { checkProjectConfig } from './rules.js';
import { type ProjectDocument, projectDocumentSchema } from './schema.js';

const ID = '11111111-1111-4111-8111-111111111111';

function document(delivery: Record<string, unknown> | undefined): ProjectDocument {
  return projectDocumentSchema.parse({
    $schema: `${SCHEMA_BASE}/project-v1.json`,
    version: 1,
    project: { id: ID, slug: 'demo', name: 'Demo' },
    source: {
      type: 'git',
      git: { repository: 'github.com/o/r', defaultBranch: 'dev', branches: ['dev'] },
    },
    workspace: { isolation: 'worktree' },
    validation: { gate: { type: 'none' } },
    environments: {
      dev: { tier: 'dev', deploysFrom: 'dev', deployment: { mode: 'external' }, testing: 'qa' },
      prod: { tier: 'production', deploysFrom: 'dev', deployment: { mode: 'external' } },
    },
    promotions: [],
    rollback: { strategy: 'none' },
    execution: { plugin: { source: 'o/p', ref: 'a'.repeat(40) } },
    ...(delivery ? { delivery } : {}),
  });
}

const ctx = { bindings: new Map(), testingProfileIds: new Set(['qa']) };
const refusals = (doc: ProjectDocument) =>
  checkProjectConfig(doc, ctx).filter((r) => r.code.startsWith('JUDGED_ON'));

describe('delivery.judgedOn', () => {
  it('takes a declared non-production environment, beside its testing profile', () => {
    expect(refusals(document({ judgedOn: 'dev' }))).toEqual([]);
    expect(checkProjectConfig(document({ judgedOn: 'dev' }), ctx)).toEqual([]);
  });

  it('is optional, and a document without it is refused nothing', () => {
    expect(refusals(document(undefined))).toEqual([]);
    expect(refusals(document({ verdictsRequired: true }))).toEqual([]);
  });

  it('refuses an environment the document does not declare, naming the ones it does', () => {
    const [refusal, ...rest] = refusals(document({ judgedOn: 'stg' }));
    expect(rest).toEqual([]);
    expect(refusal).toMatchObject({ code: 'JUDGED_ON_UNDECLARED', path: '/delivery/judgedOn' });
    expect(refusal?.detail).toContain('one of: dev, prod');
  });

  it('refuses production by name: a release is proven before it reaches production', () => {
    const [refusal] = refusals(document({ judgedOn: 'prod' }));
    expect(refusal).toMatchObject({ code: 'JUDGED_ON_PRODUCTION', path: '/delivery/judgedOn' });
    expect(refusal?.detail).toContain('REQ-36 BC-18');
  });

  it('refuses a name that is not an environment name at the schema', () => {
    expect(() => document({ judgedOn: 'Dev Env' })).toThrow();
  });
});
