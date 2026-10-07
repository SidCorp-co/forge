import { contentLanguageOf } from '@forge/contracts/content-language';
import { ALWAYS_INJECT_MAX_CHARS } from '@forge/contracts/knowledge';
import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../../db/client.js';
import { type IssueStatus, type JobType, labels, projects } from '../../db/schema.js';
import {
  selectAllSlugsFromKnowledge,
  selectAlwaysInjectFromKnowledge,
  selectOnDemandSlugsFromKnowledge,
} from '../../knowledge/index.js';
import { logger } from '../../lib/logger.js';
import type { ProjectDocument, TestingProfile } from '../../project-config/index.js';
import {
  listTestingProfiles,
  promotedBranch,
  readProjectDocument,
  releasePathOf,
  repositoryOf,
} from '../../project-config/index.js';
import {
  type KnowledgeObligation,
  missingProjectKnowledge,
  type RESERVED_PROJECT_FACT_KEYS,
  unreservedProjectKeyRefusal,
} from '../../projects/index.js';
import { renderTestCreds, renderTestNotes, renderTestUrls } from './environment-keys.js';
import {
  type IntegrationRow,
  loadActiveIntegrationRows,
  renderIntegrations,
} from './integration-facts.js';
import {
  CANONICAL_LADDER,
  type FactRenderContext,
  FORGE_FACTS,
  type ProjectModuleFact,
} from './registry.js';

/** Resolves a `{{project:<key>}}` reference to its text, or undefined if unknown. */
type ProjectVarResolver = (key: string) => string | undefined;

interface ProjectFactInputs {
  /** The happy-path status ladder (`registry.ts:CANONICAL_LADDER`). */
  ladder: IssueStatus[];
  /** Raw project branch columns — lets a caller that already needs this read
   *  (e.g. the system-prompt builder) reuse it instead of reading `projects`
   *  a second time for the `## Project Config` block. */
  branches: { baseBranch: string | null; deploysFrom: string | null };
  /** Resolver for `{{project:<key>}}`. */
  project: ProjectVarResolver;
  /** Slugs of this project's `injection: 'on_demand'` knowledge entries — the
   *  fetch-on-demand index, which names the tool that holds them. */
  projectFactKeys: string[];
  /** This project's `injection: 'always'` knowledge entries: rendered VERBATIM
   *  into the preamble (like a mandatory ForgeFact), and excluded from the
   *  fetch-on-demand index. Paired with their full body, in order. */
  alwaysInjectFacts: Array<{ key: string; text: string }>;
  /** The knowledge store could not be read for this project. The index is then
   *  rendered as a named absence rather than left out: an agent told nothing is
   *  an agent that concludes this project has no guides. */
  factsUnavailable: boolean;
  /** Entries this project owes and has not written, computed from what it
   *  declares. Empty for a project that owes nothing — which is a different
   *  state from one that owes something and has not answered, and the reason
   *  the contract is computed rather than listed. */
  missingObligations: KnowledgeObligation[];
  /** The project's `kind='module'` labels (ISS-595). Empty for a project with
   *  no taxonomy, which is what keeps `module-attribution` out of its prompt. */
  modules: ProjectModuleFact[];
  /** The project's content language tag, `en` where its document declares none. */
  contentLanguage: string;
}

function makeProjectResolver(src: {
  projectId: string;
  baseBranch: string | null;
  deploysFrom: string | null;
  document: ProjectDocument | null;
  profiles: ReadonlyMap<string, TestingProfile>;
  integrations: IntegrationRow[];
}): ProjectVarResolver {
  const reserved: Record<(typeof RESERVED_PROJECT_FACT_KEYS)[number], () => string | undefined> = {
    'base-branch': () => src.baseBranch ?? undefined,
    'live-branch': () => src.deploysFrom ?? undefined,
    'production-branch': () =>
      '⚠️ `{{project:production-branch}}` was retired when a project gained a declared release model (ISS-1046). Use `{{project:live-branch}}`, which resolves only where the promotions of the project document carry a landed change on to the branch its production environment deploys from. Update this skill body.',
    'repo-path': () =>
      '⚠️ `{{project:repo-path}}` was retired with the project checkout column (ISS-14): a checkout is a path on one box, named by that device binding, and a step already runs inside it — use the working directory. Update this skill body.',
    'test-urls': () => renderTestUrls(src.document),
    'test-creds': () => renderTestCreds(src.projectId, src.document),
    'test-notes': () => renderTestNotes(src.document, src.profiles),
    integrations: () => renderIntegrations(src.integrations, src.projectId),
  };
  return (key) =>
    key in reserved ? reserved[key as keyof typeof reserved]() : unreservedProjectKeyRefusal(key);
}

/**
 * The project's module taxonomy, flattened to names — the one input `module-attribution` gates on.
 *
 * Parent comes back as a NAME because the only consumer writes it into a system prompt, where an
 * id is noise an agent cannot act on: `PATCH /api/issues/:id` resolves a module by name as well as by uuid.
 */
async function loadProjectModules(projectId: string): Promise<ProjectModuleFact[]> {
  const parents = alias(labels, 'parent_labels');
  const rows = await db
    .select({ name: labels.name, parentName: parents.name })
    .from(labels)
    .leftJoin(parents, eq(labels.parentId, parents.id))
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')))
    .orderBy(labels.name);
  return rows.map((r) => ({ name: r.name, parentName: r.parentName ?? null }));
}

/** Load the per-project inputs for fact resolution: the status ladder, the
 *  `{{project:}}` resolver (project columns + project document + connected
 *  integrations) and this project's knowledge entries. */
export async function loadProjectFactInputs(projectId: string): Promise<ProjectFactInputs> {
  let baseBranch: string | null = null;
  let deploysFrom: string | null = null;
  let production: string | null = null;
  let document: ProjectDocument | null = null;
  let profiles = new Map<string, TestingProfile>();
  let integrations: IntegrationRow[] = [];
  let modules: ProjectModuleFact[] = [];
  let alwaysInjectFacts: Array<{ key: string; text: string }> = [];
  let projectFactKeys: string[] = [];
  let factsUnavailable = false;
  let missingObligations: KnowledgeObligation[] = [];
  try {
    const [row] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    integrations = await loadActiveIntegrationRows(projectId, row?.orgId ?? null);
    modules = await loadProjectModules(projectId);
  } catch {
    // defaults → empty {{project:}} resolver
  }
  const held = await readProjectDocument(projectId);
  document = held?.document ?? null;
  if (held) {
    const read = releasePathOf(held.revision, held.document);
    baseBranch = read.ok ? read.path.defaultBranch : null;
    deploysFrom = read.ok ? promotedBranch(read.path) : null;
    production = read.ok ? (read.path.production?.name ?? null) : null;
    const named = await listTestingProfiles(projectId);
    profiles = new Map(named.map((p) => [p.profileId, p.document]));
  }

  try {
    let heldSlugs: string[];
    [alwaysInjectFacts, projectFactKeys, heldSlugs] = await Promise.all([
      selectAlwaysInjectFromKnowledge(projectId),
      selectOnDemandSlugsFromKnowledge(projectId),
      selectAllSlugsFromKnowledge(projectId),
    ]);
    missingObligations = missingProjectKnowledge(
      { repository: repositoryOf(document), production },
      heldSlugs,
    );
  } catch (err) {
    factsUnavailable = true;
    alwaysInjectFacts = [];
    projectFactKeys = [];
    missingObligations = [];
    logger.error(
      { err: (err as Error).message, projectId },
      'prompt.facts: knowledge store unreadable, the prompt says so in place of the guide index',
    );
  }

  return {
    ladder: [...CANONICAL_LADDER],
    branches: { baseBranch, deploysFrom },
    project: makeProjectResolver({
      projectId,
      baseBranch,
      deploysFrom,
      document,
      profiles,
      integrations,
    }),
    projectFactKeys,
    alwaysInjectFacts,
    factsUnavailable,
    missingObligations,
    modules,
    contentLanguage: contentLanguageOf(document).contentLanguage,
  };
}

/** Demote `##` fact headers one level so they nest under `## Forge context`
 *  instead of rendering as its siblings. Standalone surfaces (the REST
 *  preview) keep the facts' own `##` headers. */
function demoteHeadings(text: string): string {
  return text.replace(/^## /gm, '### ');
}

export function renderStageFactsText(
  inputs: ProjectFactInputs,
  projectId: string,
  stage: JobType,
): string {
  const ctx: FactRenderContext = {
    projectId,
    stage,
    ladder: inputs.ladder,
    modules: inputs.modules,
    contentLanguage: inputs.contentLanguage,
  };

  const forgeText = FORGE_FACTS.filter(
    (f) =>
      f.tier === 'contextual' &&
      (!f.appliesTo || f.appliesTo.includes(stage)) &&
      (f.relevant?.(ctx) ?? true),
  )
    .map((f) => demoteHeadings(f.render(ctx)))
    .join('\n\n');

  const projectParts: string[] = [];

  const alwaysInject = inputs.alwaysInjectFacts;
  const alwaysInjectKeys = new Set(alwaysInject.map((f) => f.key));
  if (alwaysInject.length > 0) {
    const totalChars = alwaysInject.reduce((sum, f) => sum + f.text.length, 0);
    if (totalChars > ALWAYS_INJECT_MAX_CHARS) {
      logger.warn(
        {
          projectId,
          stage,
          totalChars,
          maxChars: ALWAYS_INJECT_MAX_CHARS,
          keys: alwaysInject.map((f) => f.key),
        },
        'always-inject knowledge entries exceed the char budget — every prompt for this project carries the overflow',
      );
    }
    projectParts.push(
      [
        '### Project rules (always applied)',
        'Hard rules for this project — always-injected by the project owner. Follow them exactly.',
        ...alwaysInject.map((f) => `#### ${f.key}\n${f.text}`),
      ].join('\n\n'),
    );
  }

  const integrations = inputs.project('integrations');
  if (integrations) projectParts.push(demoteHeadings(integrations));

  // Fetch-on-demand index excludes always-inject slugs — their bodies are
  // already inlined above, so listing them again as "fetch this" is noise.
  //
  // An unreadable store is said rather than left out: the two render differently
  // on purpose, because an agent shown no index concludes this project has no
  // guides, which is a claim nobody made.
  if (inputs.factsUnavailable) {
    projectParts.push(
      [
        '### Project guides (fetch on demand)',
        "This project's knowledge store could not be read while this prompt was built, so this index is missing rather than empty. Do not conclude that this project has no guides: list them yourself with `forge-runner api projects/<projectId>/knowledge` before deciding anything rests on their absence.",
      ].join('\n'),
    );
  } else {
    const indexKeys = inputs.projectFactKeys.filter((key) => !alwaysInjectKeys.has(key));
    if (indexKeys.length > 0) {
      projectParts.push(
        [
          '### Project guides (fetch on demand)',
          'Author-maintained guides exist for this project. When the task needs one, fetch its text with `forge-runner api projects/<projectId>/knowledge/<slug>` — do NOT guess its contents:',
          ...indexKeys.map((key) => `- ${key}`),
        ].join('\n'),
      );
    }
  }

  // What this project owes and has not written. Rendered only when there is
  // something owed: a project with no repository and no release model owes
  // nothing, and a block saying so on every prompt is a line that never varies.
  if (inputs.missingObligations.length > 0) {
    projectParts.push(
      [
        '### Undeclared project knowledge',
        'This project owes the entries below and none of them exists yet. Nothing here blocks you — but a step that needs one has nothing to read, so say so rather than inventing the answer, and offer the text to whoever owns the project:',
        ...inputs.missingObligations.map(
          (o) => `- \`${o.slug}\` — ${o.role} (owed because ${o.because})`,
        ),
      ].join('\n'),
    );
  }

  return ['## Forge context', forgeText, ...projectParts].filter((s) => s.length > 0).join('\n\n');
}
