import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_REFUSAL_CODES,
  type ConfigRefusal,
  checkPolicy,
  checkProjectConfig,
  type BindingFacts,
  type ProjectConfigContext,
  PURE_REFUSAL_CODES,
} from './rules.js';
import {
  type BindingDocument,
  bindingDocumentSchema,
  type PolicyDocument,
  type ProjectDocument,
  policyDocumentSchema,
  projectDocumentSchema,
  testingProfileSchema,
} from './schema.js';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const raw = (rel: string): unknown => JSON.parse(readFileSync(new URL(rel, FIXTURES), 'utf8'));

const simProject = projectDocumentSchema.parse(raw('sim-forge-dev/project.json'));
const simPolicy = policyDocumentSchema.parse(raw('sim-forge-dev/policy.json'));
const simBindings: BindingDocument[] = ['binding.beta.json', 'binding.dev.json'].map((f) =>
  bindingDocumentSchema.parse(raw(`sim-forge-dev/${f}`)),
);
const simProfiles = ['testing.beta.json', 'testing.dev.json'].map(
  (f) => testingProfileSchema.parse(raw(`sim-forge-dev/${f}`)).id,
);

// cm:why the facts a registry answers at write time, fixed per provider so each plant names its own cause.
const CAPABILITIES: Record<string, Pick<BindingFacts, 'canDeploy' | 'readsHistory'>> = {
  coolify: { canDeploy: true, readsHistory: true },
  shopify: { canDeploy: false, readsHistory: false },
};
const factsOf = (b: BindingDocument): [string, BindingFacts] => {
  const known = CAPABILITIES[b.target.provider];
  if (!known) throw new Error(`no capability fixture for provider ${b.target.provider}`);
  return [b.id, { role: b.role, provider: b.target.provider, ...known }];
};

const simCtx = (): ProjectConfigContext => ({
  bindings: new Map(simBindings.map(factsOf)),
  testingProfileIds: new Set(simProfiles),
  policy: structuredClone(simPolicy),
});

const BETA = '3f1c2a9e-7b4d-4e21-9c1a-5d6e7f8a9b0c';
const DEV = '9d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f60';
const STRANGER = '00000000-0000-4000-8000-000000000000';

const seen = new Set<string>();

function refusals(plant: (d: ProjectDocument, ctx: ProjectConfigContext) => void): ConfigRefusal[] {
  const doc = structuredClone(simProject);
  const ctx = simCtx();
  plant(doc, ctx);
  const out = checkProjectConfig(doc, ctx);
  for (const r of out) seen.add(r.code);
  return out;
}

const pick = (out: ConfigRefusal[]) => out.map(({ code, path }) => ({ code, path }));

describe('happy', () => {
  it('the forge-dev sim set has zero refusals', () => {
    expect(refusals(() => {})).toEqual([]);
  });

  it('the forge-dev example has zero refusals against its own binding and profile', () => {
    const doc = projectDocumentSchema.parse(raw('examples/forge-dev.project.json'));
    const b = bindingDocumentSchema.parse(raw('examples/forge-beta.binding.json'));
    const ctx: ProjectConfigContext = {
      bindings: new Map([factsOf(b)]),
      testingProfileIds: new Set(['forge-beta']),
      policy: policyDocumentSchema.parse(raw('examples/forge-dev.policy.json')),
    };
    expect(checkProjectConfig(doc, ctx)).toEqual([]);
  });
});

describe('sim_core.py plants (negative)', () => {
  const env = (d: ProjectDocument, n: string) => {
    const e = d.environments[n];
    if (!e) throw new Error(`sim fixture has no environment ${n}`);
    return e;
  };

  const plants: [
    string,
    (d: ProjectDocument, c: ProjectConfigContext) => void,
    { code: string; path: string },
  ][] = [
    [
      'deploy from an undeclared branch',
      (d) => {
        env(d, 'dev').deploysFrom = 'feature-x';
      },
      { code: 'DEPLOYS_FROM_UNDECLARED', path: '/environments/dev/deploysFrom' },
    ],
    [
      'two production environments',
      (d) => {
        env(d, 'dev').tier = 'production';
      },
      { code: 'PRODUCTION_NOT_UNIQUE', path: '/environments' },
    ],
    [
      'dev and beta on one binding',
      (d) => {
        env(d, 'dev').deployment = { binding: BETA, trigger: 'on-land' };
      },
      { code: 'BINDING_IN_USE', path: '/environments/dev/deployment/binding' },
    ],
    [
      'promotion back main -> dev',
      (d) => {
        d.promotions.push({ from: 'main', to: 'dev', via: 'merge' });
      },
      { code: 'PROMOTION_CYCLE', path: '/promotions' },
    ],
    [
      'binding id not on project',
      (d) => {
        env(d, 'dev').deployment = { binding: STRANGER, trigger: 'on-land' };
      },
      { code: 'BINDING_NOT_FOUND', path: '/environments/dev/deployment/binding' },
    ],
    [
      'state names an undefined profile',
      (_d, c) => {
        if (c.policy?.states.open) c.policy.states.open.permissions = 'release';
      },
      { code: 'PERMISSION_PROFILE_UNDEFINED', path: '/states/open/permissions' },
    ],
    [
      'testing profile missing',
      (d) => {
        env(d, 'dev').testing = 'staging';
      },
      { code: 'TESTING_PROFILE_NOT_FOUND', path: '/environments/dev/testing' },
    ],
  ];

  it.each(plants)('%s is refused with exactly its code', (_name, plant, want) => {
    expect(pick(refusals(plant))).toEqual([want]);
  });

  it('BINDING_IN_USE names the environment that already holds it', () => {
    const [r] = refusals((d) => {
      env(d, 'dev').deployment = { binding: BETA, trigger: 'on-land' };
    });
    expect(r?.detail).toContain('"beta"');
  });
});

describe('the rest of the pure codes', () => {
  it('DEFAULT_BRANCH_UNDECLARED', () => {
    const out = refusals((d) => {
      if (d.source.type === 'git') d.source.git.defaultBranch = 'trunk';
    });
    expect(pick(out)).toEqual([
      { code: 'DEFAULT_BRANCH_UNDECLARED', path: '/source/git/defaultBranch' },
    ]);
  });

  it('PROMOTION_REF_UNDECLARED names each undeclared end', () => {
    const out = refusals((d) => {
      d.promotions = [{ from: 'x', to: 'y', via: 'merge' }];
    });
    expect(pick(out)).toEqual([
      { code: 'PROMOTION_REF_UNDECLARED', path: '/promotions/0/from' },
      { code: 'PROMOTION_REF_UNDECLARED', path: '/promotions/0/to' },
    ]);
  });

  it('DEPLOYS_FROM_MISSING on a git project', () => {
    const out = refusals((d) => {
      delete (d.environments.dev as { deploysFrom?: string }).deploysFrom;
    });
    expect(pick(out)).toEqual([{ code: 'DEPLOYS_FROM_MISSING', path: '/environments/dev' }]);
  });

  it('BINDING_ROLE_MISMATCH when a deployment points at a non-deploy binding', () => {
    const out = refusals((_d, c) => {
      (c.bindings as Map<string, { role: 'deploy' | 'source' | 'service' }>).set(DEV, {
        role: 'service',
      });
    });
    expect(pick(out)).toEqual([
      { code: 'BINDING_ROLE_MISMATCH', path: '/environments/dev/deployment/binding' },
    ]);
  });

  it('ISOLATION_UNSUPPORTED: remote-draft on git', () => {
    const out = refusals((d) => {
      d.workspace.isolation = 'remote-draft';
    });
    expect(pick(out)).toEqual([{ code: 'ISOLATION_UNSUPPORTED', path: '/workspace/isolation' }]);
  });

  it('a no-source project: worktree isolation, github-check gate and promotions are each refused', () => {
    const out = refusals((d) => {
      d.source = { type: 'none' };
      d.environments = {};
    });
    expect(pick(out)).toEqual([
      { code: 'ISOLATION_UNSUPPORTED', path: '/workspace/isolation' },
      { code: 'GATE_UNSUPPORTED', path: '/validation/gate' },
      { code: 'PROMOTIONS_NEED_GIT', path: '/promotions' },
    ]);
  });

  it('a no-source project with declared absences is accepted', () => {
    const out = refusals((d) => {
      d.source = { type: 'none' };
      d.workspace = { isolation: 'none' };
      d.validation = { gate: { type: 'none' } };
      d.promotions = [];
      d.environments = {};
    });
    expect(out).toEqual([]);
  });

  it('storefront.binding must exist and have role source', () => {
    const shop = (c: ProjectConfigContext, role?: 'deploy' | 'source' | 'service') => {
      if (role)
        (c.bindings as Map<string, { role: 'deploy' | 'source' | 'service' }>).set(STRANGER, {
          role,
        });
    };
    const storefront = (d: ProjectDocument) => {
      d.source = { type: 'storefront', storefront: { provider: 'shopify', binding: STRANGER } };
      d.workspace = { isolation: 'remote-draft' };
      d.validation = { gate: { type: 'none' } };
      d.promotions = [];
      d.environments = {};
    };
    expect(pick(refusals((d) => storefront(d)))).toEqual([
      { code: 'BINDING_NOT_FOUND', path: '/source/storefront/binding' },
    ]);
    expect(
      pick(
        refusals((d, c) => {
          storefront(d);
          shop(c, 'deploy');
        }),
      ),
    ).toEqual([{ code: 'BINDING_ROLE_MISMATCH', path: '/source/storefront/binding' }]);
    expect(
      refusals((d, c) => {
        storefront(d);
        shop(c, 'source');
      }),
    ).toEqual([]);
  });

  it('checkPolicy stands alone and passes the sim policy', () => {
    expect(checkPolicy(simPolicy)).toEqual([]);
    const p: PolicyDocument = structuredClone(simPolicy);
    if (p.states.needs_info) p.states.needs_info.permissions = 'triage';
    expect(pick(checkPolicy(p))).toEqual([
      { code: 'PERMISSION_PROFILE_UNDEFINED', path: '/states/needs_info/permissions' },
    ]);
  });
});

describe('boundaries', () => {
  const tiers = (d: ProjectDocument, beta: 'production' | 'dev', dev: 'production' | 'dev') => {
    if (d.environments.beta) d.environments.beta.tier = beta;
    if (d.environments.dev) d.environments.dev.tier = dev;
  };

  it('exactly one production is accepted; zero is accepted; two are refused', () => {
    expect(refusals((d) => tiers(d, 'production', 'dev'))).toEqual([]);
    expect(refusals((d) => tiers(d, 'dev', 'dev'))).toEqual([]);
    expect(pick(refusals((d) => tiers(d, 'production', 'production')))).toEqual([
      { code: 'PRODUCTION_NOT_UNIQUE', path: '/environments' },
    ]);
  });

  it('a promotion cycle of length 1 is refused', () => {
    const out = refusals((d) => {
      d.promotions = [{ from: 'dev', to: 'dev', via: 'merge' }];
    });
    expect(pick(out)).toEqual([{ code: 'PROMOTION_CYCLE', path: '/promotions' }]);
    expect(out[0]?.detail).toContain('dev -> dev');
  });

  it('a promotion cycle of length 2 names both refs', () => {
    const out = refusals((d) => {
      d.promotions.push({ from: 'main', to: 'dev', via: 'cherry-pick' });
    });
    expect(out[0]?.detail).toContain('dev -> main -> dev');
  });

  it('a diamond of promotions is not a cycle', () => {
    const out = refusals((d) => {
      if (d.source.type === 'git') d.source.git.branches = ['main', 'dev', 'a', 'b'];
      d.promotions = [
        { from: 'dev', to: 'a', via: 'merge' },
        { from: 'dev', to: 'b', via: 'merge' },
        { from: 'a', to: 'main', via: 'merge' },
        { from: 'b', to: 'main', via: 'merge' },
      ];
    });
    expect(out).toEqual([]);
  });

  it('a cycle of length 3 behind a tail is found', () => {
    const out = refusals((d) => {
      if (d.source.type === 'git') d.source.git.branches = ['main', 'dev', 'a', 'b'];
      d.promotions = [
        { from: 'dev', to: 'a', via: 'merge' },
        { from: 'a', to: 'b', via: 'merge' },
        { from: 'b', to: 'main', via: 'merge' },
        { from: 'main', to: 'a', via: 'merge' },
      ];
    });
    expect(out[0]?.detail).toContain('a -> b -> main -> a');
  });

  it('an environment name holding / is escaped in the pointer', () => {
    const doc = structuredClone(simProject);
    const e = doc.environments.dev;
    if (!e) throw new Error('sim fixture has no dev');
    doc.environments = { 'a/b': { ...e, testing: 'nope' } } as ProjectDocument['environments'];
    const out = checkProjectConfig(doc, simCtx());
    expect(out.map((r) => r.path)).toEqual(['/environments/a~1b/testing']);
  });
});

describe('the declared store example', () => {
  it('refuses Forge deploying the storefront while Forge has no shopify deploy adapter', () => {
    const doc = projectDocumentSchema.parse(raw('examples/store.project.json'));
    const bindings = ['store-source.binding.json', 'store-deploy.binding.json'].map((f) =>
      bindingDocumentSchema.parse(raw(`examples/${f}`)),
    );
    expect(new Set(bindings.map((b) => b.connection)).size).toBe(1);
    const ctx: ProjectConfigContext = {
      bindings: new Map(bindings.map(factsOf)),
      testingProfileIds: new Set(['theme-preview', 'storefront-smoke']),
    };
    const out = checkProjectConfig(doc, ctx);
    for (const r of out) seen.add(r.code);
    expect(pick(out)).toEqual([
      { code: 'TRIGGER_UNSUPPORTED', path: '/environments/production/deployment/trigger' },
    ]);
    expect(out[0]?.detail).toContain('no deploy adapter for shopify');
  });

  it('passes the storefront once production is deployed outside Forge', () => {
    const doc = projectDocumentSchema.parse(raw('examples/store.project.json'));
    const production = doc.environments.production;
    if (!production) throw new Error('store example has no production');
    production.deployment = { mode: 'external' };
    const bindings = ['store-source.binding.json', 'store-deploy.binding.json'].map((f) =>
      bindingDocumentSchema.parse(raw(`examples/${f}`)),
    );
    expect(
      checkProjectConfig(doc, {
        bindings: new Map(bindings.map(factsOf)),
        testingProfileIds: new Set(['theme-preview', 'storefront-smoke']),
      }),
    ).toEqual([]);
  });

  it('refuses trigger provider through an adapter that cannot read deployment history', () => {
    const doc = projectDocumentSchema.parse(raw('examples/store.project.json'));
    const production = doc.environments.production;
    if (!production || !('binding' in production.deployment)) throw new Error('store example has no bound production');
    production.deployment = { ...production.deployment, trigger: 'provider' };
    const bindings = ['store-source.binding.json', 'store-deploy.binding.json'].map((f) =>
      bindingDocumentSchema.parse(raw(`examples/${f}`)),
    );
    const out = checkProjectConfig(doc, {
      bindings: new Map(bindings.map(factsOf)),
      testingProfileIds: new Set(['theme-preview', 'storefront-smoke']),
    });
    expect(pick(out)).toEqual([
      { code: 'TRIGGER_UNSUPPORTED', path: '/environments/production/deployment/trigger' },
    ]);
    expect(out[0]?.detail).toContain("cannot read shopify's deployment history");
  });

  it('accepts trigger provider through an adapter that reads deployment history', () => {
    expect(
      refusals((d) => {
        const dev = d.environments.dev;
        if (!dev || !('binding' in dev.deployment)) throw new Error('sim fixture has no bound dev');
        dev.deployment = { ...dev.deployment, trigger: 'provider' };
      }),
    ).toEqual([]);
  });

  it('refuses deploysFrom on a storefront project', () => {
    const doc = projectDocumentSchema.parse(raw('examples/store.project.json'));
    const preview = doc.environments.preview;
    if (!preview) throw new Error('store example has no preview');
    preview.deploysFrom = 'main';
    const production = doc.environments.production;
    if (!production) throw new Error('store example has no production');
    production.deployment = { mode: 'external' };
    const bindings = ['store-source.binding.json', 'store-deploy.binding.json'].map((f) =>
      bindingDocumentSchema.parse(raw(`examples/${f}`)),
    );
    const out = checkProjectConfig(doc, {
      bindings: new Map(bindings.map(factsOf)),
      testingProfileIds: new Set(['theme-preview', 'storefront-smoke']),
    });
    for (const r of out) seen.add(r.code);
    expect(pick(out)).toEqual([
      { code: 'DEPLOYS_FROM_NEEDS_GIT', path: '/environments/preview/deploysFrom' },
    ]);
  });
});

describe('the code vocabulary', () => {
  it('holds every code of the design table once', () => {
    expect(new Set(CONFIG_REFUSAL_CODES).size).toBe(CONFIG_REFUSAL_CODES.length);
    expect(CONFIG_REFUSAL_CODES).toHaveLength(25);
  });

  it('every pure code is emitted by some plant in this file', () => {
    expect([...seen].sort()).toEqual([...PURE_REFUSAL_CODES].sort());
  });
});
