import { isPlainObject as isRecord } from '@forge/contracts/document-patch';
import { REPO_PATH_MESSAGE } from '@forge/contracts/repo-path';
import type { z } from 'zod';
import { jsonPointer as pointer } from '../lib/refusal.js';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';
import type { ProjectDocument, STOREFRONT_PROVIDERS } from '../project-config/index.js';
import { type ApiRefusal, parseVersionedDocument } from '../project-config/index.js';
import { ownLinkRefusals, versionRefusals } from './link-own-rules.js';
import {
  ARTEFACT_KINDS,
  BUILDER_TRIGGERS,
  type BuilderRunWrite,
  builderRunWriteSchema,
  type CallSite,
  FINDING_CLASSIFICATIONS,
  LINK_STATES,
  type LinkWrite,
  linkWriteSchema,
  STEP_STATUSES,
} from './link-schema.js';
import type { Checked, EcosystemRefusal, LinkRefusalCode } from './refusals.js';
import type { InterfaceDocument } from './schema.js';

const closed = (values: readonly string[]) => `one of ${values.join(' | ')}, and nothing else`;

const ENUM_RENAMES: readonly [RegExp, LinkRefusalCode, string][] = [
  [/^\/state$/, 'LINK_STATE_UNKNOWN', `a link's state is ${closed(LINK_STATES)}`],
  [/^\/trigger\/kind$/, 'BUILDER_TRIGGER_UNKNOWN', `a builder run is ${closed(BUILDER_TRIGGERS)}`],
  [/^\/steps\/\d+\/status$/, 'STEP_STATUS_UNKNOWN', `a step's status is ${closed(STEP_STATUSES)}`],
  [
    /^\/findings\/\d+\/classification$/,
    'FINDING_CLASSIFICATION_UNKNOWN',
    `a finding is ${closed(FINDING_CLASSIFICATIONS)}`,
  ],
];

function renameLinkParseRefusals(refusals: readonly ApiRefusal[]): EcosystemRefusal[] {
  return refusals.map((r): EcosystemRefusal => {
    if (r.code !== 'SCHEMA_VIOLATION') return r;
    if (r.detail === REPO_PATH_MESSAGE) {
      return {
        code: 'PATH_OUTSIDE_REPO',
        path: r.path,
        detail: `${REPO_PATH_MESSAGE}; the path names a file inside the consumer's checkout and is stored as written, never resolved.`,
      };
    }
    const hit = ENUM_RENAMES.find(([re]) => re.test(r.path));
    return hit ? { code: hit[1], path: r.path, detail: `${r.detail}; ${hit[2]}.` } : r;
  });
}

function ownedBy(
  claimed: unknown,
  projectId: string,
  path: string,
  what: string,
): EcosystemRefusal[] {
  if (claimed === undefined || claimed === projectId) return [];
  return [
    {
      code: 'PROJECT_ID_IMMUTABLE',
      path,
      detail: `project ${JSON.stringify(claimed)} is not this project; ${what} written at /api/projects/${projectId} names ${projectId}.`,
    },
  ];
}

function parseOwned<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  what: string,
  owner: EcosystemRefusal[],
): Checked<T> {
  const parsed = parseVersionedDocument(schema, raw, what);
  if (!parsed.ok) {
    return { ok: false, refusals: [...owner, ...renameLinkParseRefusals(parsed.refusals)] };
  }
  return owner.length > 0 ? { ok: false, refusals: owner } : parsed;
}

export function parseLink(raw: unknown, consumerId: string): Checked<LinkWrite> {
  const claimed = isRecord(raw) && isRecord(raw.consumer) ? raw.consumer.project : undefined;
  const owner = ownedBy(claimed, consumerId, '/consumer/project', 'a link');
  return parseOwned(linkWriteSchema, raw, 'link', owner);
}

export function parseBuilderRun(raw: unknown, projectId: string): Checked<BuilderRunWrite> {
  const owner = ownedBy(
    isRecord(raw) ? raw.project : undefined,
    projectId,
    '/project',
    'a builder run',
  );
  return parseOwned(builderRunWriteSchema, raw, 'builder-run', owner);
}

/** A link and a builder run are the consuming project's finding in its own code: ecosystem-links.write there. */
export const writerRefusal = (facts: PermissionFacts, what: string): EcosystemRefusal | null =>
  permissionRefusal(facts, 'ecosystem-links.write', what);

interface ProviderSide {
  id: string;
  activeIn: ReadonlySet<string>;
  interface: InterfaceDocument | null;
}

/** Where a project's own code lives, which decides what its builder run reads and what its call sites name. */
export type BuilderSource =
  | { type: 'repository' }
  | { type: 'storefront'; provider: (typeof STOREFRONT_PROVIDERS)[number] };

// a project with no document, or `source.type: none`, keeps the repository reading every run had before storefront sources were read; only a declared storefront changes it
export function builderSourceOf(doc: ProjectDocument | null | undefined): BuilderSource {
  return doc?.source.type === 'storefront'
    ? { type: 'storefront', provider: doc.source.storefront.provider }
    : { type: 'repository' };
}

const describeSource = (source: BuilderSource) =>
  source.type === 'storefront'
    ? `a storefront on ${source.provider} (source.type storefront)`
    : 'a repository (source.type git)';

// a call site is read the way the consumer's own code is held: a repository consumer names a file and line, a storefront consumer an artefact its provider declares; the wrong kind is refused by name, never stored beside the right one
export function callSiteRefusals(
  sites: readonly { site: CallSite; at: string }[],
  source: BuilderSource,
  project: string,
): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  const held = `project ${project}'s code is ${describeSource(source)}`;
  for (const { site, at } of sites) {
    if (source.type === 'repository') {
      if (site.artefact === undefined) continue;
      out.push({
        code: 'CALL_SITE_KIND_MISMATCH',
        path: `${at}/artefact`,
        detail: `${held}, so a call site names a repository path and line, not a storefront artefact.`,
      });
      continue;
    }
    if (site.artefact === undefined) {
      out.push({
        code: 'CALL_SITE_KIND_MISMATCH',
        path: `${at}/path`,
        detail: `${held}, so a call site names a storefront artefact ({ kind, id }), not a repository path; no checkout holds it.`,
      });
      continue;
    }
    const kinds = ARTEFACT_KINDS[source.provider] ?? [];
    if (kinds.includes(site.artefact.kind)) continue;
    out.push({
      code: 'ARTEFACT_KIND_UNKNOWN',
      path: `${at}/artefact/kind`,
      detail:
        kinds.length > 0
          ? `"${site.artefact.kind}" is not an artefact ${source.provider} holds; a ${source.provider} call site names ${kinds.join(' | ')}.`
          : `no artefact kinds are declared for provider ${source.provider}, so a call site cannot name one of its artefacts yet.`,
    });
  }
  return out;
}

export interface LinkWorld {
  consumerSource: BuilderSource;
  consumerActiveIn: ReadonlySet<string>;
  provider: ProviderSide | null;
  versions: ReadonlySet<string>;
  duplicateOf: string | null;
}

function guideRefusals(doc: LinkWrite): EcosystemRefusal[] {
  if (doc.state === 'building' || doc.callSites.length > 0) return [];
  return [
    {
      code: 'LINK_GUIDE_WITHOUT_CALL_SITE',
      path: '/callSites',
      detail: `a link in state ${doc.state} names at least one call site; only a link still being built may carry none.`,
    },
  ];
}

function memberRefusals(doc: LinkWrite, ecosystem: string, world: LinkWorld): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  if (!world.consumerActiveIn.has(ecosystem)) {
    out.push({
      code: 'LINK_CONSUMER_NOT_MEMBER',
      path: '/ecosystem',
      detail: `project ${doc.consumer.project} is not an active member of ecosystem ${ecosystem}; a project links only inside an ecosystem it has joined.`,
    });
  }
  if (world.provider && !world.provider.activeIn.has(ecosystem)) {
    out.push({
      code: 'LINK_PROVIDER_NOT_MEMBER',
      path: '/contract/provider',
      detail: `provider ${doc.contract.provider} is not an active member of ecosystem ${ecosystem}; a link reaches only a contract published inside an ecosystem both sides belong to.`,
    });
  }
  return out;
}

function referenceRefusals(doc: LinkWrite, world: LinkWorld): EcosystemRefusal[] {
  const ref = `${doc.contract.provider}/${doc.contract.slug}`;
  if (doc.contract.provider === doc.consumer.project) return ownLinkRefusals(doc, world, ref);
  if (doc.ecosystem === undefined) {
    return [
      {
        code: 'LINK_ECOSYSTEM_MISSING',
        path: '/ecosystem',
        detail: `${ref} is another project's contract; only a link to the project's own contract names no ecosystem. Name the ecosystem both projects are active members of.`,
      },
    ];
  }
  const members = memberRefusals(doc, doc.ecosystem, world);
  if (!world.provider) {
    return [
      ...members,
      {
        code: 'REF_UNRESOLVED',
        path: '/contract/provider',
        detail: `no project has the id ${doc.contract.provider}.`,
      },
    ];
  }
  if (members.length > 0) return members;
  const pub = world.provider.interface?.publishes[doc.contract.slug];
  if (!pub?.ecosystems.includes(doc.ecosystem)) {
    return [
      {
        code: 'REF_NOT_PUBLISHED',
        path: '/contract/slug',
        detail: `${ref} is not a contract its provider publishes in ecosystem ${doc.ecosystem}; a link reaches only a published contract, never a module or a guess.`,
      },
    ];
  }
  return versionRefusals(doc, world, ref);
}

export function checkLink(doc: LinkWrite, world: LinkWorld): EcosystemRefusal[] {
  const sites = doc.callSites.map((site, i) => ({ site, at: pointer(['callSites', i]) }));
  const out = [
    ...callSiteRefusals(sites, world.consumerSource, doc.consumer.project),
    ...guideRefusals(doc),
    ...referenceRefusals(doc, world),
  ];
  if (world.duplicateOf !== null) {
    out.push({
      code: 'LINK_DUPLICATE',
      path: '/consumer/module',
      detail: `link ${world.duplicateOf} already joins ${doc.consumer.module} to ${doc.contract.provider}/${doc.contract.slug}; a module links to a contract once, and that link is refreshed by PUT, not written again.`,
    });
  }
  return out;
}

const changed = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);

export function immutable(
  pairs: readonly [string, unknown, unknown][],
  code: 'LINK_IDENTITY_IMMUTABLE' | 'BUILDER_RUN_IMMUTABLE',
  what: string,
): EcosystemRefusal[] {
  return pairs
    .filter(([, was, now]) => changed(was, now))
    .map(([path, was]) => ({
      code,
      path,
      detail: `${what}, so ${path} stays ${JSON.stringify(was)}; write a new one instead.`,
    }));
}

export const linkIdentityRefusals = (stored: LinkWrite, next: LinkWrite) =>
  immutable(
    [
      ['/ecosystem', stored.ecosystem, next.ecosystem],
      ['/consumer/module', stored.consumer.module, next.consumer.module],
      ['/contract', stored.contract, next.contract],
    ],
    'LINK_IDENTITY_IMMUTABLE',
    'a link is one module joined to one contract in one ecosystem',
  );
