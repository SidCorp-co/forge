import { jsonPointer as pointer } from '../lib/refusal.js';
import { type BuilderSource, callSiteRefusals, immutable } from './link-rules.js';
import { BUILDER_RUN_SCHEMA_ID, type BuilderRunWrite } from './link-schema.js';
import type { EcosystemRefusal } from './refusals.js';
import type { InterfaceDocument } from './schema.js';

// a superseded run is closed for good: another run carries its work, so no write reopens or rewrites it, and only the supersede verb ever names supersededBy
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
const REPO_BUILDER_STEPS = [
  'read-repo',
  'find-outbound-calls',
  'match-contracts',
  'write-links',
  'check',
  'publish-role',
] as const;

/** The same run for a storefront project: its code is what the provider holds, so it reads that, not a checkout. */
const STOREFRONT_BUILDER_STEPS = [
  'read-storefront',
  'find-provider-usage',
  'match-contracts',
  'write-links',
  'check',
  'publish-role',
] as const;

// the steps are derived when a run opens and then stored as data: a run already open keeps the steps it was opened with
const builderStepsFor = (source: BuilderSource): readonly string[] =>
  source.type === 'storefront' ? STOREFRONT_BUILDER_STEPS : REPO_BUILDER_STEPS;

/** Whether a run's stored steps are not the ones its project's source type derives now: it was opened against another source. */
export const stepsStale = (doc: Pick<BuilderRunWrite, 'steps'>, source: BuilderSource): boolean =>
  doc.steps.map((s) => s.name).join('\n') !== builderStepsFor(source).join('\n');

const OPEN_STEP: ReadonlySet<string> = new Set(['pending', 'running']);

// a run is open while any step is still pending or running; there is no status column, so the steps are the one place it is read from, in SQL (link-store.ts:openBuilderRunOf) as here
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

const COMMIT = /^[0-9a-f]{40}$/;
const NO_COMMIT = /^0{40}$/;

/** What one reported push owes a project's builder: a run with the trigger it opens with, nothing, or a refusal. */
export type PushReading =
  | { kind: 'open'; trigger: BuilderRunWrite['trigger'] }
  | { kind: 'none'; why: string }
  | { kind: 'refused'; refusal: EcosystemRefusal };

// a push re-reads the project's own code, so only the branch the project builds from (its document's source.git.defaultBranch, the branch a joined run reads in builder-head.ts:projectHead) counts, never the host's default branch; a push that cannot be placed on a branch is refused by name, never read as a push to it (ISS-597)
export function pushReading(input: {
  projectId: string;
  branch: string | null;
  buildBranch: string | null;
  commit: string | null;
  at: string;
}): PushReading {
  const { projectId, branch, buildBranch, commit, at } = input;
  if (!commit || NO_COMMIT.test(commit) || !COMMIT.test(commit)) {
    return { kind: 'none', why: 'the push names no commit (a branch deletion re-reads no code)' };
  }
  if (branch === null) {
    return unattributed(
      `a push of ${commit} to project ${projectId} names no branch (a tag or another ref), so it cannot be read as a push to the branch the project builds from`,
    );
  }
  if (buildBranch === null) {
    return unattributed(
      `project ${projectId} declares no build branch (source.git.defaultBranch in its project document), so a push of ${commit} to ${branch} cannot be attributed to it; declare it with PUT /api/projects/:id/config`,
    );
  }
  if (branch !== buildBranch) {
    return {
      kind: 'none',
      why: `${branch} is not ${buildBranch}, the branch project ${projectId} builds from`,
    };
  }
  return {
    kind: 'open',
    trigger: {
      kind: 'push',
      sha: commit,
      head: { ref: `refs/heads/${branch}`, readAt: at, via: 'source-host' },
    },
  };
}

const unattributed = (detail: string): PushReading => ({
  kind: 'refused',
  refusal: {
    code: 'BUILDER_RUN_PUSH_UNATTRIBUTED',
    path: '/trigger',
    detail: `${detail}. No builder run was opened.`,
  },
});

export interface DeclaredWithoutCallSite {
  classification: 'declared_without_call_site';
  contract: string;
  at: string;
  detail: string;
}

// a declared consumption no finished run found a call site for is said, never silently kept: the interface claims a use the code does not show
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
      detail: `a run is closed as superseded only by the supersede verb (POST /api/projects/${doc.project}/builder-runs/:runId/supersede), which opens the run that replaces it; a written document never names supersededBy.`,
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
