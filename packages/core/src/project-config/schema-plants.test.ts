import { describe, expect, it } from 'vitest';
import type { ProjectConfigSchemaName } from './json-schema.js';
import { clone, type Doc, expectAccepted, expectRefused, read } from './schema.fixture.js';

const p = read('examples/forge-dev.project.json');
const pol = read('examples/forge-dev.policy.json');
const t = read('examples/forge-beta.testing.json');
const b = read('examples/forge-beta.binding.json');
const st = read('examples/live.state.json');

const plants: [
  string,
  ProjectConfigSchemaName,
  () => Doc,
  { path: string; code?: string; key?: string },
][] = [
  [
    'derived key releaseModel',
    'project',
    () => ({ ...clone(p), releaseModel: 'publish' }),
    { path: '', key: 'releaseModel' },
  ],
  [
    'tier not in enum',
    'project',
    () => {
      const d = clone(p);
      d.environments.live.tier = 'prod';
      return d;
    },
    { path: '/environments/live/tier', code: 'invalid_value' },
  ],
  [
    'invalid git ref',
    'project',
    () => {
      const d = clone(p);
      d.source.git.defaultBranch = 'main..x';
      return d;
    },
    { path: '/source/git/defaultBranch', code: 'invalid_format' },
  ],
  [
    'environment with no deployment',
    'project',
    () => {
      const d = clone(p);
      delete d.environments.live.deployment;
      return d;
    },
    { path: '/environments/live/deployment' },
  ],
  [
    'trigger not in enum',
    'project',
    () => {
      const d = clone(p);
      d.environments.live.deployment.trigger = 'always';
      return d;
    },
    { path: '/environments/live/deployment/trigger', code: 'invalid_value' },
  ],
  [
    'binding without trigger',
    'project',
    () => {
      const d = clone(p);
      d.environments.live.deployment = { binding: d.environments.live.deployment.binding };
      return d;
    },
    { path: '/environments/live/deployment/trigger', code: 'invalid_value' },
  ],
  [
    'probe identifies not in enum',
    'project',
    () => {
      const d = clone(p);
      d.environments.live.verification.runtime[0].identifies = 'commit';
      return d;
    },
    { path: '/environments/live/verification/runtime/0/identifies', code: 'invalid_value' },
  ],
  [
    'old commitUrl key',
    'project',
    () => {
      const d = clone(p);
      d.environments.live.commitUrl = 'https://x/version';
      return d;
    },
    { path: '/environments/live', key: 'commitUrl' },
  ],
  ['tags (dropped)', 'project', () => ({ ...clone(p), tags: ['core'] }), { path: '', key: 'tags' }],
  [
    'coolify target without app uuid',
    'binding',
    () => ({ ...clone(b), target: { provider: 'coolify' } }),
    { path: '/target/applicationUuid', code: 'invalid_type' },
  ],
  [
    'credential inside binding',
    'binding',
    () => {
      const d = clone(b);
      d.target.token = 'abc';
      return d;
    },
    { path: '/target', key: 'token' },
  ],
  [
    'binding role not in enum',
    'binding',
    () => ({ ...clone(b), role: 'deployer' }),
    { path: '/role', code: 'invalid_value' },
  ],
  [
    'evidence not in enum',
    'environment-state',
    () => ({ ...clone(st), evidence: 'verified' }),
    { path: '/evidence', code: 'invalid_value' },
  ],
  [
    'artifact without identity',
    'environment-state',
    () => ({ ...clone(st), artifact: { kind: 'container-image' } }),
    { path: '/artifact/id', code: 'invalid_type' },
  ],
  [
    'executor not pinned',
    'project',
    () => {
      const d = clone(p);
      d.execution.plugin.ref = null;
      return d;
    },
    { path: '/execution/plugin/ref', code: 'invalid_type' },
  ],
  [
    'second source adapter',
    'project',
    () => {
      const d = clone(p);
      d.source.storefront = { provider: 'shopify', binding: p.project.id };
      return d;
    },
    { path: '/source', key: 'storefront' },
  ],
  [
    'non-https url',
    'project',
    () => {
      const d = clone(p);
      d.environments.live.url = 'http://forge-beta.sidcorp.co';
      return d;
    },
    { path: '/environments/live/url', code: 'invalid_format' },
  ],
  [
    'env name not a slug',
    'project',
    () => {
      const d = clone(p);
      d.environments['Live Env'] = d.environments.live;
      return d;
    },
    { path: '/environments/Live Env', code: 'invalid_key' },
  ],
  [
    'machine path in project',
    'project',
    () => {
      const d = clone(p);
      d.project.repoPath = '/home/x';
      return d;
    },
    { path: '/project', key: 'repoPath' },
  ],
  [
    'mode on a state',
    'policy',
    () => {
      const d = clone(pol);
      d.states.open.mode = 'auto';
      return d;
    },
    { path: '/states/open', key: 'mode' },
  ],
  [
    'status that takes no run',
    'policy',
    () => {
      const d = clone(pol);
      d.states.awaiting_release = { model: 'opus', permissions: 'development' };
      return d;
    },
    { path: '/states', key: 'awaiting_release' },
  ],
  [
    'model not in enum',
    'policy',
    () => {
      const d = clone(pol);
      d.states.open.model = 'gpt-5';
      return d;
    },
    { path: '/states/open/model', code: 'invalid_value' },
  ],
  [
    'literal password',
    'testing-profile',
    () => {
      const d = clone(t);
      d.actors.admin.credential = 'Chuongld@113';
      return d;
    },
    { path: '/actors/admin/credential', code: 'invalid_format' },
  ],
  [
    'extra password field',
    'testing-profile',
    () => {
      const d = clone(t);
      d.actors.admin.password = 'x';
      return d;
    },
    { path: '/actors/admin', key: 'password' },
  ],
];

describe('schema plants (negative)', () => {
  it('plants all twenty-four', () => {
    expect(plants).toHaveLength(24);
  });

  it.each(plants)('%s is refused at the planted path', (_name, schema, make, want) => {
    expectRefused(schema, make(), want);
  });

  it('accepts a production environment with no runtime probe', () => {
    const d = clone(p);
    delete d.environments.live.verification;
    expectAccepted('project', d);
  });
});
