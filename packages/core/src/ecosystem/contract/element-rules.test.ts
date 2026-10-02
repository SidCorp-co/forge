import { describe, expect, it } from 'vitest';
import { channelWorld, contractFacts, doc, FORGE_API_2026_10_01 } from '../channel.fixture.js';
import { type ChannelWorld, documentRefusals, parseChannelDocument } from '../channel-rules.js';
import { clone, type Doc, example, interfaceRefusals } from '../ecosystem.fixture.js';
import type { InterfaceDocument } from '../schema.js';
import type { ContractFacts } from './citations.js';
import { indexContract } from './elements.js';
import type { StoredVersion } from './store.js';
import { uploadRefusals } from './upload-rules.js';

function refusalsOf(
  d: Doc,
  contracts: Partial<ContractFacts> = {},
  world: Partial<ChannelWorld> = {},
) {
  const parsed = parseChannelDocument(d);
  if (!parsed.ok) throw new Error(`the plant broke the shape: ${JSON.stringify(parsed.refusals)}`);
  return documentRefusals(
    parsed.value,
    channelWorld({ contracts: { ...contractFacts(), ...contracts }, ...world }),
  ).map((r) => `${r.code} ${r.path}`);
}

const cn = () => doc('FP-CN-12.document.json');
const rfi = () => doc('FP-RFI-4.document.json');
const ack = () => doc('FP-ACK-7.document.json');
const cr = () => doc('FP-CR-3.document.json');

describe('a channel document names only elements of the version it cites (ELEMENT_NOT_IN_CONTRACT)', () => {
  it('refuses a change notice whose change names an element the version does not have', () => {
    const d = cn();
    d.body.changes[0].element = 'POST /api/nowhere';
    expect(refusalsOf(d)).toContain('ELEMENT_NOT_IN_CONTRACT /body/changes/0/element');
  });

  it('takes an element that only the version before has, since a removal names what is gone', () => {
    const d = cn();
    d.body.changes[0] = {
      element: 'DELETE /api/old',
      kind: 'removed',
      text: 'The old route is gone.',
    };
    const facts = contractFacts();
    const versions = new Map(facts.versions);
    versions.set('forge/forge-api@2026-09-20', {
      elements: new Set(['DELETE /api/old']),
      previous: null,
      recordedOn: '2026-09-20',
    });
    expect(refusalsOf(d, { versions }).filter((r) => r.startsWith('ELEMENT'))).toEqual([]);
  });

  it('refuses a deprecation of an element the version does not have', () => {
    const d = cn();
    d.body.deprecation = {
      elements: ['GET /api/never'],
      deprecatedOn: '2026-10-01',
      sunsetOn: '2027-01-01',
    };
    expect(refusalsOf(d)).toContain('ELEMENT_NOT_IN_CONTRACT /body/deprecation/elements/0');
  });

  it('refuses an RFI reference to an element the cited version does not have, and to a version never recorded', () => {
    const d = rfi();
    d.body.references[0].element = 'GET /api/nowhere';
    expect(refusalsOf(d)).toContain('ELEMENT_NOT_IN_CONTRACT /body/references/0/element');
    const v = rfi();
    v.body.references[0].contractVersion = '2030-01-01';
    expect(refusalsOf(v)).toContain('VERSION_UNKNOWN /body/references/0/contractVersion');
  });

  it('reads an RFI reference with no version against the latest one', () => {
    const d = rfi();
    delete d.body.references[0].contractVersion;
    d.body.references[0].element = 'GET /api/nowhere';
    expect(refusalsOf(d)).toContain('ELEMENT_NOT_IN_CONTRACT /body/references/0/element');
  });

  it('refuses an acknowledgement blocked on an element the notice did not touch any version of', () => {
    const d = ack();
    d.body = {
      disposition: 'blocked',
      blockedOn: [{ element: 'GET /api/nowhere', reason: 'We cannot adapt in time.' }],
    };
    expect(refusalsOf(d)).toContain('ELEMENT_NOT_IN_CONTRACT /body/blockedOn/0/element');
  });

  it('checks nothing against a version core holds no element list for, as an opaque contract', () => {
    const d = cn();
    d.body.changes[0].element = 'anything at all';
    delete d.body.examples;
    const versions = new Map([
      ['forge/forge-api@2026-10-01', { elements: null, previous: null, recordedOn: '2026-09-01' }],
    ]);
    expect(refusalsOf(d, { versions }).filter((r) => r.startsWith('ELEMENT'))).toEqual([]);
  });
});

describe('an example matches the schema of its element in the cited version (EXAMPLE_NOT_IN_CONTRACT)', () => {
  it('refuses a payload the cited request schema does not take', () => {
    const d = cn();
    d.body.examples[0].payload = { issueIds: ['ISS-1303'] };
    expect(refusalsOf(d)).toContain('EXAMPLE_NOT_IN_CONTRACT /body/examples/0');
  });

  it('refuses an example whose cited schema holds a pattern the linear engine cannot run (CONTRACT_PATTERN_UNSAFE)', () => {
    const api = structuredClone(FORGE_API_2026_10_01);
    const body = api.paths['/api/devices/me/run-sessions'].post.requestBody?.content[
      'application/json'
    ].schema as { properties: { policyVersion: { pattern: string } } } | undefined;
    if (!body) throw new Error('the fixture lost its request body');
    body.properties.policyVersion.pattern = '^([0-9a-f])\\1{39}$';
    const indexes = new Map([['forge/forge-api@2026-10-01', indexContract('openapi', api)]]);
    expect(refusalsOf(cn(), { indexes })).toContain('CONTRACT_PATTERN_UNSAFE /body/examples/0');
  });

  it('refuses rather than passes an example whose version artifact could not be read', () => {
    expect(refusalsOf(cn(), { indexes: new Map() })).toContain(
      'EXAMPLE_NOT_IN_CONTRACT /body/examples/0',
    );
  });

  it('holds a change request to nothing, since it proposes what the contract does not have yet', () => {
    const d = cr();
    d.body.examples = [
      { element: 'POST /api/not-yet', direction: 'request', payload: { anything: true } },
    ];
    expect(refusalsOf(d).filter((r) => r.startsWith('EXAMPLE') || r.startsWith('ELEMENT'))).toEqual(
      [],
    );
  });
});

describe('the measured diff of the cited version binds the notice', () => {
  const measured = (classification: 'unknown' | 'initial' | 'breaking') =>
    new Map([['forge/forge-api@2026-10-01', { classification, changes: [] }]]);

  it('refuses non-breaking where the version measured unknown (CLASSIFICATION_BELOW_MEASURED)', () => {
    const d = cn();
    d.body.classification = 'non-breaking';
    expect(refusalsOf(d, { measured: measured('unknown') })).toContain(
      'CLASSIFICATION_BELOW_MEASURED /body/classification',
    );
  });

  it('lets a first version, measured initial, be classified by the notice', () => {
    const d = cn();
    d.body.classification = 'non-breaking';
    expect(
      refusalsOf(d, { measured: measured('initial') }).filter((r) =>
        r.startsWith('CLASSIFICATION'),
      ),
    ).toEqual([]);
  });
});

describe('a consumer declares only elements its builtAgainst version has (ELEMENT_NOT_IN_CONTRACT)', () => {
  it('refuses an element forge-api 2026-09-20 does not list', () => {
    const d = clone(example('forge-plugin.interface.json'));
    d.consumes[0].elements.push('GET /api/never');
    expect(interfaceRefusals(d).map((r) => `${r.code} ${r.path}`)).toEqual([
      'ELEMENT_NOT_IN_CONTRACT /consumes/0/elements/3',
    ]);
  });

  it('takes every element the version lists, and checks none where the version keeps no list', () => {
    expect(interfaceRefusals(example('forge-plugin.interface.json'))).toEqual([]);
    const d = clone(example('forge-plugin.interface.json'));
    d.consumes[1].elements = ['forge_anything'];
    expect(interfaceRefusals(d)).toEqual([]);
  });
});

const latest = (elements: string[] | null): StoredVersion =>
  ({ version: '2026-10-01', elements }) as unknown as StoredVersion;

describe('a version posted by the provider is refused by name where it does not fit the publication', () => {
  const iface = example('forge.interface.json') as InterfaceDocument;
  const body = (b: object) => b as Parameters<typeof uploadRefusals>[0]['body'];
  const codes = (
    contract: string,
    b: object,
    l: StoredVersion | null = latest(['GET /api/issues/{id}']),
  ) =>
    uploadRefusals({ project: { slug: 'forge' }, contract, iface, body: body(b), latest: l }).map(
      (r) => `${r.code} ${r.path}`,
    );

  it.each([
    ['a contract the interface does not publish', 'nope', {}, 'CONTRACT_NOT_PUBLISHED /'],
    [
      'bytes for a contract read from git',
      'forge-api',
      { artifact: '{}' },
      'ARTIFACT_MEASURED_FROM_GIT /artifact',
    ],
    ['nothing for a contract read from git', 'forge-api', {}, 'NOTHING_TO_RECORD /'],
    [
      'a semantic change sent with bytes',
      'forge-api',
      {
        artifact: '{}',
        semantic: { classification: 'breaking', reason: 'r', elements: ['GET /api/issues/{id}'] },
      },
      'SEMANTIC_WITH_ARTIFACT /semantic',
    ],
    [
      'a semantic change declared non-breaking',
      'forge-api',
      {
        semantic: {
          classification: 'non-breaking',
          reason: 'r',
          elements: ['GET /api/issues/{id}'],
        },
      },
      'SEMANTIC_BELOW_UNKNOWN /semantic/classification',
    ],
    [
      'a semantic change to an element the version lacks',
      'forge-api',
      { semantic: { classification: 'breaking', reason: 'r', elements: ['GET /api/never'] } },
      'ELEMENT_NOT_IN_CONTRACT /semantic/elements/0',
    ],
  ])('refuses %s', (_n, contract, b, want) => {
    expect(codes(contract, b)).toContain(want);
  });

  it('takes a semantic change to an element the latest version has', () => {
    expect(
      codes('forge-api', {
        semantic: {
          classification: 'breaking',
          reason: 'The state machine no longer offers the jump.',
          elements: ['GET /api/issues/{id}'],
        },
      }),
    ).toEqual([]);
  });
});
