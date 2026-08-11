// Project-resolution layer for the Forge Facts registry. The registry's
// render() is pure; this module fetches the per-project inputs (currently the
// enabled status ladder from `agentConfig.pipelineConfig`) and produces the
// `FactRenderContext`, then renders facts into the shape the REST + MCP
// surfaces return. Lives apart from registry.ts so the registry stays free of
// DB/env coupling.

import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { type IssueStatus, type JobType, projects } from '../../db/schema.js';
import { integrationGuideSlug, loadOrgGuideProviders } from '../../guides/integration-guides.js';
import {
  renderSentryTargetsLine,
  resolveSentryTargets,
} from '../../integrations/sentry/targets.js';
import type { SentryConfig, SentryTarget } from '../../integrations/sentry/types.js';
import { listBindingsForProject } from '../../integrations/store.js';
import { getIntegrationGuide, getIntegrationUsage } from '../../integrations/usage-registry.js';
import {
  selectAlwaysInjectFromKnowledge,
  selectOnDemandSlugsFromKnowledge,
} from '../../knowledge/service.js';
import { logger } from '../../logger.js';
import {
  PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
  type RESERVED_PROJECT_FACT_KEYS,
  selectAlwaysInjectFacts,
} from '../../projects/project-facts.js';
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
  /** projectFacts flagged `alwaysInject` (ISS-521): rendered VERBATIM into the
   *  preamble (like a mandatory ForgeFact), and excluded from the
   *  fetch-on-demand guide index. Paired with their full text, in map order. */
  alwaysInjectFacts: Array<{ key: string; text: string }>;
}

interface TestingUrl {
  label?: string;
  url: string;
}

interface IntegrationRow {
  provider: string;
  environment: string;
  lastHealthStatus: string | null;
  /** ISS-526 — Sentry-only: the labelled targets the agent picks between when
   *  querying the Sentry MCP (org/project is passed per call). */
  sentryTargets?: SentryTarget[];
  /** Operator text for THIS project's binding, rendered verbatim. */
  instructions?: string | null;
  /** The caller's org authored a runtime guide for this provider. */
  hasOrgGuide?: boolean;
}

// cm:edge contract -> packages/core/src/integrations/usage-registry.ts — per-provider usage hints are data-driven there; adding an integration edits that table, never this renderer
// cm:why one query, shared by the pipeline facts block and the chat preamble — a chat-only copy of the active-filter + sentry-target mapping would drift from what a job sees
export async function loadActiveIntegrationRows(
  projectId: string,
  orgId?: string | null,
): Promise<IntegrationRow[]> {
  // cm:guard both flags must hold — an inactive binding on an active connection (or vice versa) injects nothing at dispatch, so listing it here would advertise tools the agent will not receive
  const pairs = await listBindingsForProject(projectId);
  const active = pairs.filter((p) => p.binding.active && p.connection.active);
  if (active.length === 0) return [];

  // cm:why the guide lookup is skipped when nothing is connected — an unconnected project must not pay a query to discover guides it will never be pointed at
  const orgGuides = orgId ? await loadOrgGuideProviders(orgId) : new Set<string>();

  return active.map((p) => ({
    provider: p.binding.provider,
    environment: p.binding.environment,
    lastHealthStatus: p.connection.lastHealthStatus,
    instructions: p.binding.instructions ?? null,
    hasOrgGuide: orgGuides.has(p.binding.provider),
    ...(p.binding.provider === 'sentry'
      ? {
          sentryTargets: resolveSentryTargets(p.connection.config as SentryConfig),
        }
      : {}),
  }));
}

// cm:why indented as a markdown sub-block so multi-line operator text cannot break out of its bullet and read as a new top-level instruction to the agent
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

export function renderIntegrations(rows: IntegrationRow[]): string {
  if (rows.length === 0) {
    return '## Project integrations\nNo external integrations are connected to this project.';
  }
  const lines = rows.map((r) => {
    const hint = getIntegrationUsage(r.provider);
    const health = r.lastHealthStatus ? ` (health: ${r.lastHealthStatus})` : '';
    // cm:why the org's runtime guide WINS over the seeded slug — an org authors one precisely to correct or replace the shipped default, so pointing at the default would send the agent to the text they overrode
    const guideSlug = r.hasOrgGuide
      ? integrationGuideSlug(r.provider)
      : getIntegrationGuide(r.provider);
    const guidePointer = guideSlug ? ` Full guide: \`forge_guide get ${guideSlug}\`.` : '';
    const bullet = `- **${r.provider}** [${r.environment}]${health} — ${hint}${guidePointer}`;
    const extra: string[] = [];
    // ISS-526 — for Sentry, list the configured targets (label → org/project
    // → notes) under the bullet so the agent knows which org/project slug to
    // pass per Sentry MCP call. The MCP server still gets only host + token.
    if (r.provider === 'sentry' && r.sentryTargets && r.sentryTargets.length > 0) {
      extra.push(renderSentryTargetsLine(r.sentryTargets));
    }
    // cm:guard operator text, rendered VERBATIM and last so it is the final word for this provider — never summarise, reorder or truncate it here
    const instructions = r.instructions?.trim();
    if (instructions) {
      extra.push(
        `  - Project-specific instructions for **${r.provider}** (follow these over the general guide where they conflict):\n${indentBlock(instructions)}`,
      );
    }
    return extra.length > 0 ? `${bullet}\n${extra.join('\n')}` : bullet;
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
  let projectFactsConfig: Record<string, { alwaysInject?: boolean }> = {};
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
        orgId: projects.orgId,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const ac =
      (row?.agentConfig as {
        pipelineConfig?: { states?: typeof states };
        projectFacts?: Record<string, string>;
        projectFactsConfig?: Record<string, { alwaysInject?: boolean }>;
      } | null) ?? null;
    states = ac?.pipelineConfig?.states ?? {};
    projectFacts = ac?.projectFacts && typeof ac.projectFacts === 'object' ? ac.projectFacts : {};
    projectFactsConfig =
      ac?.projectFactsConfig && typeof ac.projectFactsConfig === 'object'
        ? ac.projectFactsConfig
        : {};
    const pd = (row?.previewDeploy as { testingUrls?: TestingUrl[] } | null) ?? null;
    testingUrls = Array.isArray(pd?.testingUrls) ? pd.testingUrls : [];
    baseBranch = row?.baseBranch ?? null;
    productionBranch = row?.productionBranch ?? null;
    repoPath = row?.repoPath ?? null;

    integrations = await loadActiveIntegrationRows(projectId, row?.orgId ?? null);
  } catch {
    // defaults → full ladder, empty {{project:}} resolver
  }

  // When the flag is ON, source alwaysInjectFacts and projectFactKeys from
  // knowledge_entries instead of agentConfig. The {{project:key}} resolver
  // still reads agentConfig for the deprecation window so inline templates
  // kept in skill files continue to work.
  let alwaysInjectFacts: Array<{ key: string; text: string }>;
  let projectFactKeys: string[];
  if (env.KNOWLEDGE_INJECTION_ENABLED) {
    try {
      [alwaysInjectFacts, projectFactKeys] = await Promise.all([
        selectAlwaysInjectFromKnowledge(projectId),
        selectOnDemandSlugsFromKnowledge(projectId),
      ]);
    } catch {
      // Fallback to agentConfig on any DB error so the prompt never breaks.
      alwaysInjectFacts = selectAlwaysInjectFacts(projectFacts, projectFactsConfig);
      projectFactKeys = Object.keys(projectFacts);
    }
  } else {
    alwaysInjectFacts = selectAlwaysInjectFacts(projectFacts, projectFactsConfig);
    projectFactKeys = Object.keys(projectFacts);
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
    projectFactKeys,
    alwaysInjectFacts,
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

  // Always-inject projectFacts (ISS-521) — the per-project hard-rules layer.
  // Rendered VERBATIM, like a mandatory ForgeFact, so a rule the agent MUST
  // follow is guaranteed-read rather than fetch-on-demand. Capped at
  // PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS over the sum of bodies — never
  // silently dropped (a truncated hard rule is worse than a warned-but-present
  // one), but an overflow logs a warning so an over-eager flag is visible.
  const alwaysInject = inputs.alwaysInjectFacts;
  const alwaysInjectKeys = new Set(alwaysInject.map((f) => f.key));
  if (alwaysInject.length > 0) {
    const totalChars = alwaysInject.reduce((sum, f) => sum + f.text.length, 0);
    if (totalChars > PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS) {
      logger.warn(
        {
          projectId,
          stage,
          totalChars,
          maxChars: PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
          keys: alwaysInject.map((f) => f.key),
        },
        'projectFacts always-inject content exceeds char budget — every prompt for this project carries the overflow',
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

  // Fetch-on-demand index excludes always-inject keys — their bodies are
  // already inlined above, so listing them again as "fetch this" is noise.
  const indexKeys = inputs.projectFactKeys.filter((key) => !alwaysInjectKeys.has(key));
  if (indexKeys.length > 0) {
    projectParts.push(
      [
        '### Project guides (fetch on demand)',
        'Author-maintained guides exist for this project. When the task needs one, fetch its text via `forge_knowledge` (action `get` + slug) — do NOT guess its contents:',
        ...indexKeys.map((key) => `- ${key}`),
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
