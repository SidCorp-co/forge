import type { ChannelWorld, HoldWorld, MeasuredVersion } from './channel-rules.js';
import type { ChannelDocument, ThreadHold } from './channel-schema.js';
import { type Doc, example, exampleFiles, FP, SLUGS } from './ecosystem.fixture.js';
import { versionKey } from './interface-rules.js';
import type { EcosystemDocument, InterfaceDocument } from './schema.js';
import type { EdgeRow } from './store.js';

export const FORGE = 'da368b0a-8e21-4763-9d90-8f7b9d0c7115';
export const PLUGIN = '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3';
export const EPOD = '9a5d4e7c-bf6b-4c2e-9354-6e7f8091a2b4';
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
      { element: 'GET /api/issues/{id}', level: 'non-breaking' },
    ],
  },
};

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
    measured: new Map(Object.entries(MEASURED)),
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
