import type { ChannelWorld, HoldWorld, MeasuredVersion } from './channel-rules.js';
import type { ChannelDocument, ThreadHold } from './channel-schema.js';
import type { ContractFacts, VersionFacts } from './contract/citations.js';
import { indexContract } from './contract/elements.js';
import { type Doc, ELEMENTS, example, exampleFiles, FP, SLUGS } from './ecosystem.fixture.js';
import { versionKey } from './interface-rules.js';
import type { EcosystemDocument, InterfaceDocument } from './schema.js';
import type { EdgeRow } from './store.js';

export const FORGE = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
export const PLUGIN = '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3';
export const OWNER = 'bc7f6a9e-d18d-4e40-b576-8091a2b3c4d6';

const VERSIONS: Record<string, string[]> = {
  'forge/forge-api': ['2026-09-20', '2026-10-01'],
  'forge/forge-mcp': ['2026-09-20'],
  'forge-plugin/driver-skill': ['2026-09-28'],
};

// cm:why the measured diff of forge-api 2026-10-01 from the design's contract-version example; E2 writes these rows, E3 only reads them.
const MEASURED: Record<string, MeasuredVersion> = {
  'forge/forge-api@2026-10-01': {
    classification: 'breaking',
    changes: [
      { element: 'POST /api/devices/me/run-sessions', level: 'breaking' },
      { element: 'GET /api/issues/{id}', level: 'info' },
    ],
  },
};

const RUN_SESSION_BODY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    issueIds: { type: 'array', items: { type: 'string' } },
    policyVersion: { type: 'string', pattern: '^[0-9a-f]{40}$' },
  },
  required: ['issueIds', 'policyVersion'],
};

const operation = (body?: object) => ({
  ...(body ? { requestBody: { content: { 'application/json': { schema: body } } } } : {}),
  responses: { default: { description: 'Undeclared.' } },
});

// cm:why the slice of forge-api 2026-10-01 the design examples cite, so the element and example rules run over every example rather than skip it
export const FORGE_API_2026_10_01 = {
  openapi: '3.1.0',
  info: { title: 'forge-api', version: 'unversioned' },
  paths: {
    '/api/issues/{id}': { get: operation() },
    '/api/issues/{id}/phase': { post: operation({ type: 'object' }) },
    '/api/devices/me/run-sessions': { post: operation(RUN_SESSION_BODY) },
  },
};

export function contractFacts(): ContractFacts {
  const versions = new Map<string, VersionFacts>(
    Object.entries(ELEMENTS).map(([key, es]) => [
      key,
      { elements: new Set(es), previous: key.endsWith('2026-10-01') ? '2026-09-20' : null },
    ]),
  );
  return {
    measured: new Map(Object.entries(MEASURED)),
    versions,
    latest: new Map([['forge/forge-api', '2026-10-01']]),
    indexes: new Map([
      ['forge/forge-api@2026-10-01', indexContract('openapi', FORGE_API_2026_10_01)],
    ]),
  };
}

const idOf = (slug: string) => {
  const hit = Object.entries(SLUGS).find(([, s]) => s === slug);
  if (!hit) throw new Error(`no fixture project ${slug}`);
  return hit[0];
};

export const documentFiles = () => exampleFiles().filter((f) => f.endsWith('.document.json'));
export const holdFiles = () => exampleFiles().filter((f) => f.endsWith('.hold.json'));

export function publishedByNumber(): Map<string, ChannelDocument> {
  return new Map(
    documentFiles()
      .map((f) => example(f) as ChannelDocument)
      .filter((d) => d.number)
      .map((d) => [d.number as string, d]),
  );
}

export function channelWorld(overrides: Partial<ChannelWorld> = {}): ChannelWorld {
  const interfaces = new Map<string, InterfaceDocument>(
    ['forge.interface.json', 'forge-plugin.interface.json'].map((f) => {
      const i = example(f) as InterfaceDocument;
      return [i.project, i];
    }),
  );
  const edges: EdgeRow[] = [...interfaces.values()].flatMap((i) =>
    i.consumes.map((c) => {
      const [provider = '', contractSlug = ''] = c.contract.split('/');
      return {
        consumerProjectId: i.project,
        providerProjectId: idOf(provider),
        contractSlug,
        ecosystemId: c.ecosystem,
        builtAgainst: c.builtAgainst,
      };
    }),
  );
  return {
    today: '2026-10-01',
    ecosystemId: FP,
    ecosystem: example('forge-platform.ecosystem.json') as EcosystemDocument,
    active: new Set([FORGE, PLUGIN]),
    slugOf: new Map(Object.entries(SLUGS)),
    interfaces,
    edges,
    versions: new Map(
      Object.entries(VERSIONS).map(([ref, vs]) => {
        const [provider = '', contract = ''] = ref.split('/');
        return [versionKey(idOf(provider), contract), new Set(vs)];
      }),
    ),
    contracts: contractFacts(),
    documents: publishedByNumber(),
    holds: holdFiles().map((f) => example(f) as ThreadHold),
    ...overrides,
  };
}

export function holdWorld(overrides: Partial<HoldWorld> = {}): HoldWorld {
  return {
    documents: publishedByNumber(),
    mayActFor: (person, project) => person === OWNER && (project === FORGE || project === PLUGIN),
    holds: [],
    ...overrides,
  };
}

export const doc = (file: string): Doc => example(file);
