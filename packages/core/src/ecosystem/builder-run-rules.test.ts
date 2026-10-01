import { describe, expect, it } from 'vitest';
import { type Doc, emittedAccepts, example, FP } from './ecosystem.fixture.js';
import {
  type BuilderRunWorld,
  builderRunIdentityRefusals,
  checkBuilderRun,
  parseBuilderRun,
} from './link-rules.js';
import { LIMITS } from './link-schema.js';

const FORGE = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
const PLUGIN = '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3';
const LINK = 'c17f6a9e-1d2b-4c3a-8e4f-5a6b7c8d9e01';

const record = (): Doc => example('forge-plugin.builder-run.json');

function written(patch: (d: Doc) => void = () => {}): Doc {
  const d = record();
  delete d.id;
  delete d.createdAt;
  delete d.updatedAt;
  patch(d);
  return d;
}

const world = (over: Partial<BuilderRunWorld> = {}): BuilderRunWorld => ({
  projectActiveIn: new Set([FP]),
  published: new Set([`${FORGE}/forge-api`, `${FORGE}/forge-mcp`]),
  links: new Set([LINK]),
  ...over,
});

function codesAt(raw: Doc, w: BuilderRunWorld = world()) {
  const parsed = parseBuilderRun(raw, PLUGIN);
  const refusals = parsed.ok ? checkBuilderRun(parsed.value, w) : parsed.refusals;
  return refusals.map((r) => `${r.code} ${r.path}`);
}

describe('a builder run the joining project records', () => {
  it('is accepted whole, and its record by the emitted schema', () => {
    expect(codesAt(written())).toEqual([]);
    expect(emittedAccepts(record())).toBe(true);
  });

  it('may have found nothing and written no link yet', () => {
    expect(
      codesAt(
        written((d) => {
          d.findings = [];
          d.links = [];
          d.trigger.kind = 'push';
        }),
      ),
    ).toEqual([]);
  });

  it('holds its steps and findings at their bound and refuses one past it', () => {
    const steps = Array.from({ length: LIMITS.steps }, (_, i) => ({
      name: `s${i}`,
      status: 'pending',
    }));
    const finding = record().findings[2];
    const findings = Array.from({ length: LIMITS.findings }, () => finding);
    expect(codesAt(written((d) => Object.assign(d, { steps, findings })))).toEqual([]);
    const past = written((d) =>
      Object.assign(d, {
        steps: [...steps, { name: 'extra', status: 'pending' }],
        findings: [...findings, finding],
      }),
    );
    expect(codesAt(past)).toEqual(['SCHEMA_VIOLATION /steps', 'SCHEMA_VIOLATION /findings']);
  });
});

const plants: [string, Doc, BuilderRunWorld, string][] = [
  [
    'a trigger outside the enum',
    written((d) => (d.trigger.kind = 'cron')),
    world(),
    'BUILDER_TRIGGER_UNKNOWN /trigger/kind',
  ],
  [
    'a step status outside the enum',
    written((d) => (d.steps[0].status = 'done')),
    world(),
    'STEP_STATUS_UNKNOWN /steps/0/status',
  ],
  [
    'a finding classification outside the enum',
    written((d) => (d.findings[0].classification = 'external')),
    world(),
    'FINDING_CLASSIFICATION_UNKNOWN /findings/0/classification',
  ],
  [
    'a finding site outside the repo',
    written((d) => (d.findings[1].site.path = '/usr/lib/a.js')),
    world(),
    'PATH_OUTSIDE_REPO /findings/1/site/path',
  ],
  [
    'a step named twice',
    written((d) => (d.steps[1].name = 'scan')),
    world(),
    'SCHEMA_VIOLATION /steps',
  ],
  ['a run with no step', written((d) => (d.steps = [])), world(), 'SCHEMA_VIOLATION /steps'],
  [
    'an outside finding with no host',
    written((d) => delete d.findings[1].host),
    world(),
    'SCHEMA_VIOLATION /findings/1/host',
  ],
  [
    'a matched finding to a contract nobody publishes here',
    written(() => {}),
    world({ published: new Set() }),
    'REF_NOT_PUBLISHED /findings/0/contract',
  ],
  [
    'a link the project does not hold',
    written(() => {}),
    world({ links: new Set() }),
    'BUILDER_RUN_LINK_UNKNOWN /links/0',
  ],
  [
    'a project that is not an active member',
    written(() => {}),
    world({ projectActiveIn: new Set() }),
    'BUILDER_RUN_NOT_MEMBER /ecosystem',
  ],
  [
    'a run naming another project',
    written((d) => (d.project = FORGE)),
    world(),
    'PROJECT_ID_IMMUTABLE /project',
  ],
];

describe('every planted builder run is refused by its own code', () => {
  it.each(plants)('%s', (_name, doc, w, expected) => {
    expect(codesAt(doc, w)).toEqual([expected]);
  });

  const shapeOnly = plants.filter(([name]) =>
    [
      'a trigger outside the enum',
      'a step status outside the enum',
      'a finding classification outside the enum',
      'a finding site outside the repo',
      'a run with no step',
      'an outside finding with no host',
    ].includes(name),
  );
  it.each(shapeOnly)('the emitted schema refuses %s too', (_name, doc) => {
    expect(emittedAccepts({ ...record(), ...doc })).toBe(false);
  });
});

describe('an updated builder run keeps its trigger and ecosystem', () => {
  const parsed = (d: Doc) => {
    const p = parseBuilderRun(d, PLUGIN);
    if (!p.ok) throw new Error('the fixture run does not parse');
    return p.value;
  };

  it('accepts progressing steps', () => {
    const next = parsed(written((d) => (d.steps[2].status = 'succeeded')));
    expect(builderRunIdentityRefusals(parsed(written()), next)).toEqual([]);
  });

  it('refuses a moved trigger by name', () => {
    const next = parsed(written((d) => (d.trigger.kind = 'push')));
    expect(builderRunIdentityRefusals(parsed(written()), next).map((r) => r.code)).toEqual([
      'BUILDER_RUN_IMMUTABLE',
    ]);
  });
});
