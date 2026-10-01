import { readdirSync, readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseVersionedDocument } from '../project-config/documents.js';
import type { InterfaceWorld, ProviderView } from './interface-rules.js';
import { checkInterface, versionKey } from './interface-rules.js';
import { ecosystemJsonSchemas } from './json-schema.js';
import { type EcosystemRefusal, renameParseRefusals } from './refusals.js';
import {
  type EcosystemDocument,
  ecosystemDocumentSchema,
  type InterfaceDocument,
  interfaceDocumentSchema,
} from './schema.js';

// biome-ignore lint/suspicious/noExplicitAny: plants mutate fixtures at arbitrary depth
export type Doc = Record<string, any>;

const EXAMPLES = new URL('./fixtures/examples/', import.meta.url);
export const example = (file: string): Doc =>
  JSON.parse(readFileSync(new URL(file, EXAMPLES), 'utf8'));
export const exampleFiles = (): string[] =>
  readdirSync(EXAMPLES).filter((f) => f.endsWith('.json'));

const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
addFormats(ajv);
const VALIDATORS = new Map(
  Object.values(ecosystemJsonSchemas).map((s) => [(s as { $id: string }).$id, ajv.compile(s)]),
);

export function emittedAccepts(doc: Doc): boolean {
  const validate = VALIDATORS.get(doc.$schema);
  if (!validate) throw new Error(`no emitted schema for ${doc.$schema}`);
  return validate(doc) as boolean;
}

export const FP = '5c1f0a3e-7b2d-4e8a-9f10-2a3b4c5d6e70';
export const EPS = '6d2a1b4f-8c3e-4f9b-8a21-3b4c5d6e7f81';

export const SLUGS: Record<string, string> = {
  'da368b0a-8e21-4763-9d90-8f7b9d0c7115': 'forge',
  '8f4c3d6b-ae5a-4b1d-8243-5d6e7f8091a3': 'forge-plugin',
  '9a5d4e7c-bf6b-4c2e-9354-6e7f8091a2b4': 'epodsystem',
  'ab6e5f8d-c07c-4d3f-a465-7f8091a2b3c5': 'store-a',
};

const MEMBERS: Record<string, string[]> = {
  [FP]: ['forge', 'forge-plugin'],
  [EPS]: ['epodsystem', 'store-a'],
};

const VERSIONS: Record<string, string[]> = {
  'forge/forge-api': ['2026-09-20', '2026-10-01'],
  'forge/forge-mcp': ['2026-09-20'],
  'forge-plugin/driver-skill': ['2026-09-28'],
  'epodsystem/checkout-api': ['3.2.0'],
  'epodsystem/theme-runtime': ['2.0.0'],
};

const FORGE_API = [
  'GET /api/issues/{id}',
  'POST /api/issues/{id}/phase',
  'POST /api/devices/me/run-sessions',
];

// cm:why the forge-api elements the example consumer and channel documents cite, as a recorded version would list them; versions absent here are unindexed, as an opaque contract is
export const ELEMENTS: Record<string, string[]> = {
  'forge/forge-api@2026-09-20': FORGE_API,
  'forge/forge-api@2026-10-01': FORGE_API,
};

const INTERFACES = [
  'forge.interface.json',
  'forge-plugin.interface.json',
  'epodsystem.interface.json',
  'store-a.interface.json',
];

const idOf = (slug: string) => {
  const hit = Object.entries(SLUGS).find(([, s]) => s === slug);
  if (!hit) throw new Error(`no fixture project ${slug}`);
  return hit[0];
};

export function worldFor(
  self: Doc,
  consumersOfMine: InterfaceWorld['consumersOfMine'] = [],
): InterfaceWorld {
  const me = SLUGS[self.project] ?? 'unknown';
  const ecos = [
    example('forge-platform.ecosystem.json'),
    example('epod-storefronts.ecosystem.json'),
  ];
  const activeIn = (slug: string) =>
    new Set(Object.entries(MEMBERS).flatMap(([eco, slugs]) => (slugs.includes(slug) ? [eco] : [])));
  const providers = new Map<string, ProviderView>(
    INTERFACES.map((f) => example(f)).map((i) => [
      SLUGS[i.project] ?? 'unknown',
      {
        projectId: i.project,
        interface: i as InterfaceDocument,
        activeIn: activeIn(SLUGS[i.project] ?? ''),
      },
    ]),
  );
  const versions = new Map(
    Object.entries(VERSIONS).map(([ref, vs]) => {
      const [provider = '', contract = ''] = ref.split('/');
      return [versionKey(idOf(provider), contract), new Set(vs)];
    }),
  );
  return {
    project: { id: self.project, slug: me },
    activeEcosystems: new Map(
      ecos
        .filter((e) => activeIn(me).has(e.ecosystem.id))
        .map((e) => [e.ecosystem.id, e as EcosystemDocument]),
    ),
    providers,
    versions,
    elements: new Map(
      Object.entries(ELEMENTS).map(([key, es]) => {
        const [ref = '', version = ''] = key.split('@');
        const [provider = '', contract = ''] = ref.split('/');
        return [`${versionKey(idOf(provider), contract)}@${version}`, new Set(es)];
      }),
    ),
    consumersOfMine,
  };
}

export function interfaceRefusals(
  doc: Doc,
  consumersOfMine: InterfaceWorld['consumersOfMine'] = [],
): EcosystemRefusal[] {
  const parsed = parseVersionedDocument(interfaceDocumentSchema, doc, 'interface');
  if (!parsed.ok) return renameParseRefusals(parsed.refusals);
  return checkInterface(parsed.value, worldFor(doc, consumersOfMine));
}

export function ecosystemRefusals(doc: Doc): EcosystemRefusal[] {
  const parsed = parseVersionedDocument(ecosystemDocumentSchema, doc, 'ecosystem');
  return parsed.ok ? [] : parsed.refusals;
}

export const clone = (d: Doc): Doc => structuredClone(d);
