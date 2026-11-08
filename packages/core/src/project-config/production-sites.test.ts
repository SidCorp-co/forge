/**
 * ISS-1077 (sidcorp-mail, 2026-11-07): one product runs as two production sites, mail.sidcorp.co
 * and webmail.lighthuman.vn, each through its own Coolify binding, and the project document had no
 * shape for the second: a list under `deployment` was refused SCHEMA_VIOLATION, a second production
 * environment PRODUCTION_NOT_UNIQUE. Production now names its further sites in `sites`, each with its
 * own binding; the environment's own deployment is its first site, named by the environment.
 *
 * @direct-test-of packages/core/src/project-config/schema.ts
 * @direct-test-of packages/core/src/project-config/rules.ts
 * @direct-test-of packages/core/src/project-config/promotion-path.ts
 */
import { SCHEMA_BASE } from '@forge/contracts/project-config';
import { describe, expect, it } from 'vitest';
import { parseVersionedDocument } from './documents.js';
import { productionOf, sitesOf } from './promotion-path.js';
import { readDeployMapOf } from './release-path.js';
import { checkProjectConfig } from './rules.js';
import { type ProjectDocument, projectDocumentSchema } from './schema.js';

const ID = '11111111-1111-4111-8111-111111111111';
const MAIL = '9a191d14-0000-4000-8000-000000000001';
const WEBMAIL = '3326a2b5-0000-4000-8000-000000000002';
const STAGING = '5e5e5e5e-0000-4000-8000-000000000003';

function raw(environments: Record<string, unknown>): Record<string, unknown> {
  return {
    $schema: `${SCHEMA_BASE}/project-v1.json`,
    version: 1,
    project: { id: ID, slug: 'sidcorp-mail', name: 'Sidcorp Mail' },
    source: {
      type: 'git',
      git: { repository: 'github.com/o/r', defaultBranch: 'master', branches: ['master'] },
    },
    workspace: { isolation: 'worktree' },
    validation: { gate: { type: 'none' } },
    environments,
    promotions: [],
    rollback: { strategy: 'none' },
    execution: { plugin: { source: 'o/p', ref: 'a'.repeat(40) } },
  };
}

const parse = (environments: Record<string, unknown>) =>
  parseVersionedDocument(projectDocumentSchema, raw(environments), 'project');

const binding = (provider = 'coolify') => ({
  provider,
  role: 'deploy' as const,
  active: true,
  canDeploy: true,
  readsHistory: true,
});
const ctx = {
  bindings: new Map([
    [MAIL, binding()],
    [WEBMAIL, binding()],
    [STAGING, binding()],
  ]),
  testingProfileIds: new Set<string>(),
};

const parsed = (environments: Record<string, unknown>): ProjectDocument => {
  const read = parse(environments);
  if (!read.ok) throw new Error(JSON.stringify(read.refusals));
  return read.value;
};
const refusals = (environments: Record<string, unknown>) =>
  checkProjectConfig(parsed(environments), ctx).map((r) => ({ code: r.code, path: r.path }));

const mail = {
  tier: 'production',
  deploysFrom: 'master',
  deployment: { binding: MAIL, trigger: 'on-request' },
  url: 'https://mail.sidcorp.co',
};
const webmail = {
  name: 'webmail',
  deployment: { binding: WEBMAIL, trigger: 'on-request' },
  url: 'https://webmail.lighthuman.vn',
  verification: {
    runtime: [
      {
        type: 'http',
        url: 'https://webmail.lighthuman.vn/version',
        path: 'version',
        identifies: 'source',
      },
    ],
  },
};

describe('a production of several sites', () => {
  it('is declared: production names a second site with its own binding, and every rule passes', () => {
    expect(parse({ production: { ...mail, sites: [webmail] } }).ok).toBe(true);
    expect(refusals({ production: { ...mail, sites: [webmail] } })).toEqual([]);
  });

  it('reads as its sites: the environment’s own deployment first, named by the environment', () => {
    const doc = parsed({ production: { ...mail, sites: [webmail] } });
    const production = productionOf(doc);
    expect(production && sitesOf(production).map((s) => [s.name, s.binding, s.url])).toEqual([
      ['production', MAIL, 'https://mail.sidcorp.co'],
      ['webmail', WEBMAIL, 'https://webmail.lighthuman.vn'],
    ]);
    // each site keeps its own runtime verification, never the environment's
    expect(production && sitesOf(production)[1]?.verification?.runtime[0]?.url).toBe(
      'https://webmail.lighthuman.vn/version',
    );
    const map = readDeployMapOf(doc);
    expect([...map.productionBindings]).toEqual([MAIL, WEBMAIL]);
    expect(map.environments.get(WEBMAIL)).toEqual({
      name: 'production',
      site: 'webmail',
      trigger: 'on-request',
    });
  });

  it('a single-binding document stays valid and reads as one site', () => {
    const doc = parsed({ production: mail });
    const production = productionOf(doc);
    expect(production && sitesOf(production).map((s) => s.name)).toEqual(['production']);
    expect(refusals({ production: mail })).toEqual([]);
    expect([...readDeployMapOf(doc).productionBindings]).toEqual([MAIL]);
  });

  it('refuses a site named as another environment is, since the name is the box its deploy holds', () => {
    expect(
      refusals({
        production: { ...mail, sites: [{ ...webmail, name: 'staging' }] },
        staging: {
          tier: 'staging',
          deploysFrom: 'master',
          deployment: { binding: STAGING, trigger: 'on-land' },
        },
      }),
    ).toContainEqual({
      code: 'PRODUCTION_SITE_NAME_TAKEN',
      path: '/environments/production/sites/0/name',
    });
  });

  it('refuses two sites under one name, the environment’s own included', () => {
    expect(refusals({ production: { ...mail, sites: [webmail, webmail] } })).toContainEqual({
      code: 'PRODUCTION_SITE_NAME_TAKEN',
      path: '/environments/production/sites/1/name',
    });
    expect(
      refusals({
        production: {
          ...mail,
          sites: [{ ...webmail, name: 'production' }],
        },
      }),
    ).toContainEqual({
      code: 'PRODUCTION_SITE_NAME_TAKEN',
      path: '/environments/production/sites/0/name',
    });
  });

  // ISS-1139: catalog-api's cnw and lsm deploy outside Forge, through forge-ops, and were refused
  // PRODUCTION_SITE_UNBOUND; an external site is declared with a runtime verification of its own
  it('takes a site deployed outside Forge that reads what it serves, and refuses one that does not, by name', () => {
    const external = { mode: 'external', target: 'forge-ops' };
    const probe = {
      runtime: [{ type: 'http', url: 'https://cnw.example.vn/version', path: 'commit', identifies: 'source' }],
    };
    expect(
      refusals({
        production: {
          ...mail,
          deployment: external,
          verification: probe,
          sites: [{ name: 'lsm', deployment: external, url: 'https://lsm.example.vn', verification: probe }],
        },
      }),
    ).toEqual([]);
    const { verification: _probe, ...unprobed } = webmail;
    expect(
      refusals({ production: { ...mail, sites: [{ ...unprobed, deployment: external }] } }),
    ).toContainEqual({
      code: 'PRODUCTION_SITE_UNVERIFIED',
      path: '/environments/production/sites/0/verification',
    });
    // the environment's own site is a site too: deployed outside Forge, it reads by its own probe
    expect(
      refusals({ production: { ...mail, deployment: { mode: 'external' }, sites: [webmail] } }),
    ).toContainEqual({
      code: 'PRODUCTION_SITE_UNVERIFIED',
      path: '/environments/production/verification',
    });
  });

  it('refuses a site with no deployment at its path', () => {
    const { deployment: _none, ...unbound } = webmail;
    const read = parse({ production: { ...mail, sites: [unbound] } });
    expect(read.ok).toBe(false);
    expect(!read.ok && read.refusals.map((r) => [r.code, r.path])).toContainEqual([
      'SCHEMA_VIOLATION',
      '/environments/production/sites/0/deployment',
    ]);
  });

  it('refuses two sites naming one binding', () => {
    expect(
      refusals({
        production: {
          ...mail,
          sites: [{ ...webmail, deployment: { binding: MAIL, trigger: 'on-request' } }],
        },
      }),
    ).toContainEqual({
      code: 'BINDING_IN_USE',
      path: '/environments/production/sites/0/deployment/binding',
    });
  });

  it('refuses sites on an environment that is not production', () => {
    expect(
      refusals({
        production: mail,
        staging: {
          tier: 'staging',
          deploysFrom: 'master',
          deployment: { binding: STAGING, trigger: 'on-land' },
          sites: [webmail],
        },
      }),
    ).toContainEqual({ code: 'SITES_NEED_PRODUCTION', path: '/environments/staging/sites' });
  });

  it('keeps one production environment: a second is still PRODUCTION_NOT_UNIQUE', () => {
    expect(
      refusals({
        production: mail,
        webmail: {
          tier: 'production',
          deploysFrom: 'master',
          deployment: { binding: WEBMAIL, trigger: 'on-request' },
        },
      }),
    ).toContainEqual({ code: 'PRODUCTION_NOT_UNIQUE', path: '/environments' });
  });

  it('still refuses a list of bindings under `deployment`', () => {
    const read = parse({
      production: {
        ...mail,
        deployment: [
          { binding: MAIL, trigger: 'on-request' },
          { binding: WEBMAIL, trigger: 'on-request' },
        ],
      },
    });
    expect(!read.ok && read.refusals.map((r) => [r.code, r.path])).toContainEqual([
      'SCHEMA_VIOLATION',
      '/environments/production/deployment',
    ]);
  });
});
