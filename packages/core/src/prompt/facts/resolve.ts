// Project-resolution layer for the Forge Facts registry. The registry's
// render() is pure; this module fetches the per-project inputs (currently the
// enabled status ladder from `agentConfig.pipelineConfig`) and produces the
// `FactRenderContext`, then renders facts into the shape the REST + MCP
// surfaces return. Lives apart from registry.ts so the registry stays free of
// DB/env coupling.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { type IssueStatus, type JobType, projectIntegrations, projects } from '../../db/schema.js';
import type { RESERVED_PROJECT_FACT_KEYS } from '../../projects/project-facts.js';
import {
  CANONICAL_LADDER,
  FORGE_FACTS,
  type FactRenderContext,
  type ForgeFact,
  getFact,
} from './registry.js';

export interface ResolvedFact {
  id: string;
  title: string;
  category: ForgeFact['category'];
  tier: ForgeFact['tier'];
  scope: ForgeFact['scope'];
  namespace: ForgeFact['namespace'];
  appliesTo?: readonly JobType[];
  version: number;
  /** Project-resolved canonical text. */
  preview: string;
}

/** Resolves a `{{project:<key>}}` reference to its text, or undefined if unknown. */
export type ProjectVarResolver = (key: string) => string | undefined;

export interface ProjectFactInputs {
  /** Project happy-path ladder (enabled stages). */
  ladder: IssueStatus[];
  /** Raw project branch columns — lets a caller that already needs this read
   *  (e.g. the system-prompt builder) reuse it instead of reading `projects`
   *  a second time for the `## Project Config` block. */
  branches: { baseBranch: string | null; productionBranch: string | null };
  /** Resolver for `{{project:<key>}}`. */
  project: ProjectVarResolver;
  /** Author-defined `agentConfig.projectFacts` keys (for dumping all guides). */
  projectFactKeys: string[];
}

interface TestingUrl {
  label?: string;
  url: string;
}

interface IntegrationRow {
  provider: string;
  environment: string;
  lastHealthStatus: string | null;
}

// How an agent should use each connected integration. Listing only the
// connected providers keeps the guide accurate; the agent then knows which
// tool to reach for which task.
const INTEGRATION_USAGE: Record<string, string> = {
  coolify: 'Deploy / redeploy and poll deployment status via the `forge_coolify_deploy` tool.',
  postman:
    'Run API collections / target requests via `forge_postman_target` and the `mcp__postman__*` tools.',
};

function renderIntegrations(rows: IntegrationRow[]): string {
  if (rows.length === 0) {
    return '## Project integrations\nNo external integrations are connected to this project.';
  }
  const lines = rows.map((r) => {
    const hint = INTEGRATION_USAGE[r.provider] ?? 'Project-specific integration.';
    const health = r.lastHealthStatus ? ` (health: ${r.lastHealthStatus})` : '';
    return `- **${r.provider}** [${r.environment}]${health} — ${hint}`;
  });
  return `## Project integrations\nConnected integrations and how to use them:\n${lines.join('\n')}`;
}

// The full status sequence lives in `registry.ts` as `CANONICAL_LADDER` (one
// source of truth, also the default the `status-ladder` fact renders). NOTE:
// it is NOT STAGE_FORWARD — that map only encodes soft-SKIP edges (it omits
// real work transitions like approved→developed), so walking it would truncate
// the ladder at `approved`.

/**
 * Build the project's happy-path ladder: the canonical sequence minus any stage
 * the project disabled via `pipelineConfig.states[s].enabled === false`
 * (matches runtime soft-skip). `closed` (terminal) is always kept. Pure.
 */
function buildLadder(states: Record<string, { enabled?: boolean } | undefined>): IssueStatus[] {
  return CANONICAL_LADDER.filter((s) => states[s]?.enabled !== false);
}

/**
 * `{{project:<key>}}` resolver: reserved keys derive from first-class project
 * columns (`base-branch`, `production-branch`, `repo-path`, `test-urls`) plus a
 * security-safe pointer for `test-creds`; everything else reads the author's
 * `agentConfig.projectFacts` map. Pure.
 */
function makeProjectResolver(src: {
  baseBranch: string | null;
  productionBranch: string | null;
  repoPath: string | null;
  testingUrls: TestingUrl[];
  integrations: IntegrationRow[];
  projectFacts: Record<string, string>;
}): ProjectVarResolver {
  const reserved: Record<(typeof RESERVED_PROJECT_FACT_KEYS)[number], () => string | undefined> = {
    'base-branch': () => src.baseBranch ?? undefined,
    'production-branch': () => src.productionBranch ?? undefined,
    'repo-path': () => src.repoPath ?? undefined,
    'test-urls': () =>
      src.testingUrls.length > 0
        ? src.testingUrls.map((u) => `- ${u.label ? `${u.label}: ` : ''}${u.url}`).join('\n')
        : undefined,
    'test-creds': () =>
      'Fetch test credentials at runtime via `forge_projects.get` → `previewDeploy.testCredentials` (never hardcode secrets).',
    integrations: () => renderIntegrations(src.integrations),
  };
  return (key) =>
    key in reserved ? reserved[key as keyof typeof reserved]() : src.projectFacts[key];
}

/** Load the per-project inputs for fact resolution: the status ladder and the
 *  `{{project:}}` resolver (project columns + previewDeploy + connected
 *  integrations + the author's projectFacts map). */
export async function loadProjectFactInputs(projectId: string): Promise<ProjectFactInputs> {
  let states: Record<string, { enabled?: boolean } | undefined> = {};
  let projectFacts: Record<string, string> = {};
  let baseBranch: string | null = null;
  let productionBranch: string | null = null;
  let repoPath: string | null = null;
  let testingUrls: TestingUrl[] = [];
  let integrations: IntegrationRow[] = [];
  try {
    const [row] = await db
      .select({
        agentConfig: projects.agentConfig,
        previewDeploy: projects.previewDeploy,
        repoPath: projects.repoPath,
        baseBranch: projects.baseBranch,
        productionBranch: projects.productionBranch,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac =
      (row?.agentConfig as {
        pipelineConfig?: { states?: typeof states };
        projectFacts?: Record<string, string>;
      } | null) ?? null;
    states = ac?.pipelineConfig?.states ?? {};
    projectFacts = ac?.projectFacts && typeof ac.projectFacts === 'object' ? ac.projectFacts : {};
    const pd = (row?.previewDeploy as { testingUrls?: TestingUrl[] } | null) ?? null;
    testingUrls = Array.isArray(pd?.testingUrls) ? pd.testingUrls : [];
    baseBranch = row?.baseBranch ?? null;
    productionBranch = row?.productionBranch ?? null;
    repoPath = row?.repoPath ?? null;

    const intRows = await db
      .select({
        provider: projectIntegrations.provider,
        environment: projectIntegrations.environment,
        lastHealthStatus: projectIntegrations.lastHealthStatus,
      })
      .from(projectIntegrations)
      .where(
        and(eq(projectIntegrations.projectId, projectId), eq(projectIntegrations.active, true)),
      );
    integrations = Array.isArray(intRows) ? intRows : [];
  } catch {
    // defaults → full ladder, empty {{project:}} resolver
  }
  return {
    ladder: buildLadder(states),
    branches: { baseBranch, productionBranch },
    project: makeProjectResolver({
      baseBranch,
      productionBranch,
      repoPath,
      testingUrls,
      integrations,
      projectFacts,
    }),
    projectFactKeys: Object.keys(projectFacts),
  };
}

/** Demote `##` fact headers one level so they nest under `## Forge context`
 *  instead of rendering as its siblings. Standalone surfaces (REST/MCP
 *  preview) keep the facts' own `##` headers. */
function demoteHeadings(text: string): string {
  return text.replace(/^## /gm, '### ');
}

/**
 * Pure renderer behind `renderStageFactsBlock` — exported for unit tests.
 *
 * Inlines ONLY what steers mandatory behaviour: the stage-applicable
 * contextual facts (status ladder, enums, protocols) plus the connected
 * integrations (tool-routing info). Everything an agent can fetch through a
 * Forge tool is pointed-to, not inlined — author `projectFacts` guides render
 * as a fetch-on-demand key index (`forge_config` get), and test URLs/creds are
 * already covered by the Project Context pointer to `forge_projects.get`.
 */
export function renderStageFactsText(
  inputs: ProjectFactInputs,
  projectId: string,
  stage: JobType,
): string {
  const ctx: FactRenderContext = { projectId, stage, ladder: inputs.ladder };

  const forgeText = FORGE_FACTS.filter(
    (f) => f.tier === 'contextual' && (!f.appliesTo || f.appliesTo.includes(stage)),
  )
    .map((f) => demoteHeadings(f.render(ctx)))
    .join('\n\n');

  const projectParts: string[] = [];
  const integrations = inputs.project('integrations');
  if (integrations) projectParts.push(demoteHeadings(integrations));
  if (inputs.projectFactKeys.length > 0) {
    projectParts.push(
      [
        '### Project guides (fetch on demand)',
        'Author-maintained guides exist for this project. When the task needs one, fetch its text via `forge_config` (action `get` → `projectFacts.<key>`) — do NOT guess its contents:',
        ...inputs.projectFactKeys.map((key) => `- ${key}`),
      ].join('\n'),
    );
  }

  return ['## Forge context', forgeText, ...projectParts].filter((s) => s.length > 0).join('\n\n');
}

/**
 * Render the `## Forge context` block injected into the system prompt for a
 * pipeline `stage` (prompt/system.ts) — the project-resolved contextual facts a
 * skill at this stage needs, so skill bodies stay pure business logic.
 * Returns '' for a non-pipeline stage. See `renderStageFactsText` for what is
 * inlined vs pointed-to.
 */
export async function renderStageFactsBlock(
  projectId: string,
  stage: JobType | null,
): Promise<string> {
  if (!stage) return '';
  const inputs = await loadProjectFactInputs(projectId);
  return renderStageFactsText(inputs, projectId, stage);
}

export async function buildFactContext(
  projectId: string,
  stage?: JobType | null,
): Promise<FactRenderContext> {
  const { ladder } = await loadProjectFactInputs(projectId);
  return { projectId, stage: stage ?? null, ladder };
}

function toResolved(fact: ForgeFact, ctx: FactRenderContext): ResolvedFact {
  const base: ResolvedFact = {
    id: fact.id,
    title: fact.title,
    category: fact.category,
    tier: fact.tier,
    scope: fact.scope,
    namespace: fact.namespace,
    version: fact.version,
    preview: fact.render(ctx),
  };
  return fact.appliesTo ? { ...base, appliesTo: fact.appliesTo } : base;
}

export async function listResolvedFacts(
  projectId: string,
  stage?: JobType | null,
): Promise<ResolvedFact[]> {
  const ctx = await buildFactContext(projectId, stage);
  return FORGE_FACTS.map((f) => toResolved(f, ctx));
}

export async function getResolvedFact(
  projectId: string,
  id: string,
  stage?: JobType | null,
): Promise<ResolvedFact | undefined> {
  const fact = getFact(id);
  if (!fact) return undefined;
  const ctx = await buildFactContext(projectId, stage);
  return toResolved(fact, ctx);
}
