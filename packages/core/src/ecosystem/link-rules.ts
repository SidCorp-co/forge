import type { z } from 'zod';
import { type PermissionFacts, permissionRefusal } from '../permissions/index.js';
import {
  type ApiRefusal,
  isRecord,
  parseVersionedDocument,
  pointer,
} from '../project-config/documents.js';
import type { ProjectDocument, STOREFRONT_PROVIDERS } from '../project-config/schema.js';
import { ownLinkRefusals, versionRefusals } from './link-own-rules.js';
import {
  ARTEFACT_KINDS,
  BUILDER_RUN_SCHEMA_ID,
  BUILDER_TRIGGERS,
  type BuilderRunWrite,
  builderRunWriteSchema,
  type CallSite,
  FINDING_CLASSIFICATIONS,
  LINK_STATES,
  type LinkWrite,
  linkWriteSchema,
  REPO_PATH_MESSAGE,
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

export function renameLinkParseRefusals(refusals: readonly ApiRefusal[]): EcosystemRefusal[] {
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

export interface ProviderSide {
  id: string;
  activeIn: ReadonlySet<string>;
  interface: InterfaceDocument | null;
}

/** Where a project's own code lives, which decides what its builder run reads and what its call sites name. */
export type BuilderSource =
  | { type: 'repository' }
  | { type: 'storefront'; provider: (typeof STOREFRONT_PROVIDERS)[number] };

// cm:why a project with no document, or `source.type: none`, keeps the repository reading every run had before storefront sources were read; only a declared storefront changes it
export function builderSourceOf(doc: ProjectDocument | null | undefined): BuilderSource {
  return doc?.source.type === 'storefront'
    ? { type: 'storefront', provider: doc.source.storefront.provider }
    : { type: 'repository' };
}

const describeSource = (source: BuilderSource) =>
  source.type === 'storefront'
    ? `a storefront on ${source.provider} (source.type storefront)`
    : 'a repository (source.type git)';

// cm:why a call site is read the way the consumer's own code is held: a repository consumer names a file and line, a storefront consumer an artefact its provider declares; the wrong kind is refused by name, never stored beside the right one
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

function immutable(
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

// cm:why a superseded run is closed for good: another run carries its work, so no write reopens or rewrites it, and only the supersede verb ever names supersededBy
export function builderRunIdentityRefusals(
  stored: BuilderRunWrite,
  next: BuilderRunWrite,
): EcosystemRefusal[] {
  if (stored.supersededBy) {
    return [
      {
        code: 'BUILDER_RUN_SUPERSEDED',
        path: '/supersededBy',
        detail: `this run was superseded by run ${stored.supersededBy.run} (${stored.supersededBy.reason}); it is closed, so work the run that replaced it.`,
      },
    ];
  }
  return immutable(
    [
      ['/ecosystem', stored.ecosystem, next.ecosystem],
      ['/trigger', stored.trigger, next.trigger],
      ['/supersededBy', stored.supersededBy ?? null, next.supersededBy ?? null],
    ],
    'BUILDER_RUN_IMMUTABLE',
    'a builder run is one trigger in one ecosystem, and only the supersede verb closes one as superseded',
  );
}

export interface BuilderRunWorld {
  source: BuilderSource;
  projectActiveIn: ReadonlySet<string>;
  published: ReadonlySet<string>;
  links: ReadonlySet<string>;
  /** Another run of this project in this ecosystem that is still open, or null. */
  openRun: string | null;
  /** Whether this write creates the run; an update's identity is held by `builderRunIdentityRefusals`. */
  creating: boolean;
}

/** The steps a joined or pushed run of a repository project is opened with, in the order a master works them. */
export const REPO_BUILDER_STEPS = [
  'read-repo',
  'find-outbound-calls',
  'match-contracts',
  'write-links',
  'check',
  'publish-role',
] as const;

/** The same run for a storefront project: its code is what the provider holds, so it reads that, not a checkout. */
export const STOREFRONT_BUILDER_STEPS = [
  'read-storefront',
  'find-provider-usage',
  'match-contracts',
  'write-links',
  'check',
  'publish-role',
] as const;

// cm:why the steps are derived when a run opens and then stored as data: a run already open keeps the steps it was opened with
export const builderStepsFor = (source: BuilderSource): readonly string[] =>
  source.type === 'storefront' ? STOREFRONT_BUILDER_STEPS : REPO_BUILDER_STEPS;

/** Whether a run's stored steps are not the ones its project's source type derives now: it was opened against another source. */
export const stepsStale = (doc: Pick<BuilderRunWrite, 'steps'>, source: BuilderSource): boolean =>
  doc.steps.map((s) => s.name).join('\n') !== builderStepsFor(source).join('\n');

const OPEN_STEP: ReadonlySet<string> = new Set(['pending', 'running']);

// cm:why a run is open while any step is still pending or running; there is no status column, so the steps are the one place it is read from, in SQL (link-store.ts:openBuilderRunOf) as here
export const isOpenRun = (doc: Pick<BuilderRunWrite, 'steps'>) =>
  doc.steps.some((s) => OPEN_STEP.has(s.status));

export function openedRun(input: {
  ecosystem: string;
  project: string;
  trigger: BuilderRunWrite['trigger'];
  source: BuilderSource;
}): BuilderRunWrite {
  return {
    $schema: BUILDER_RUN_SCHEMA_ID,
    version: 1,
    ecosystem: input.ecosystem,
    project: input.project,
    trigger: input.trigger,
    steps: builderStepsFor(input.source).map((name) => ({ name, status: 'pending' as const })),
    findings: [],
    links: [],
  };
}

export interface DeclaredWithoutCallSite {
  classification: 'declared_without_call_site';
  contract: string;
  at: string;
  detail: string;
}

// cm:why a declared consumption no finished run found a call site for is said, never silently kept: the interface claims a use the code does not show
export function declaredWithoutCallSite(input: {
  ecosystem: string;
  consumes: InterfaceDocument['consumes'];
  called: ReadonlySet<string>;
}): DeclaredWithoutCallSite[] {
  return input.consumes.flatMap((c, i) =>
    c.ecosystem !== input.ecosystem || input.called.has(c.contract)
      ? []
      : [
          {
            classification: 'declared_without_call_site' as const,
            contract: c.contract,
            at: pointer(['consumes', i]),
            detail: `the interface declares it consumes ${c.contract} in ecosystem ${input.ecosystem}, and no link this project holds there names a call site for it; write the link the code uses, or take the consumption out of the interface.`,
          },
        ],
  );
}

export const contractKey = (c: { provider: string; slug: string }) => `${c.provider}/${c.slug}`;

export function checkBuilderRun(doc: BuilderRunWrite, world: BuilderRunWorld): EcosystemRefusal[] {
  if (!world.projectActiveIn.has(doc.ecosystem)) {
    return [
      {
        code: 'BUILDER_RUN_NOT_MEMBER',
        path: '/ecosystem',
        detail: `project ${doc.project} is not an active member of ecosystem ${doc.ecosystem}; a builder run reads its own code against an ecosystem it has joined.`,
      },
    ];
  }
  const sites = doc.findings.map((f, i) => ({
    site: f.site,
    at: pointer(['findings', i, 'site']),
  }));
  const out: EcosystemRefusal[] = callSiteRefusals(sites, world.source, doc.project);
  if (world.creating && doc.supersededBy) {
    out.push({
      code: 'BUILDER_RUN_IMMUTABLE',
      path: '/supersededBy',
      detail: `a run is closed as superseded only by the supersede verb (POST /api/ecosystems/${doc.ecosystem}/builder-runs/:runId/supersede), which opens the run that replaces it; a written document never names supersededBy.`,
    });
  }
  if (world.openRun !== null && isOpenRun(doc)) {
    out.push({
      code: 'BUILDER_RUN_ALREADY_OPEN',
      path: '/steps',
      detail: `builder run ${world.openRun} of project ${doc.project} in ecosystem ${doc.ecosystem} is still open; a project works one run per ecosystem at a time, so finish that one (every step succeeded, failed or skipped) before opening another.`,
    });
  }
  doc.findings.forEach((f, i) => {
    if (f.classification !== 'matched' || world.published.has(contractKey(f.contract))) return;
    out.push({
      code: 'REF_NOT_PUBLISHED',
      path: pointer(['findings', i, 'contract']),
      detail: `${contractKey(f.contract)} is not a contract an active member publishes in ecosystem ${doc.ecosystem}; a finding that matched nothing published is outside_ecosystem or unknown.`,
    });
  });
  doc.links.forEach((id, i) => {
    if (world.links.has(id)) return;
    out.push({
      code: 'BUILDER_RUN_LINK_UNKNOWN',
      path: pointer(['links', i]),
      detail: `link ${id} is not one project ${doc.project} holds in ecosystem ${doc.ecosystem}; a run names only links it wrote.`,
    });
  });
  return out;
}
