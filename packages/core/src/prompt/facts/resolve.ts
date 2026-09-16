// Project-resolution layer for the Forge Facts registry. The registry's
// render() is pure; this module fetches the per-project inputs (currently the
// enabled status ladder from `agentConfig.pipelineConfig`) and produces the
// `FactRenderContext`, then renders facts into the shape the REST + MCP
// surfaces return. Lives apart from registry.ts so the registry stays free of
// DB/env coupling.

import { and, eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import {
  type BindingRole,
  type DeployStage,
  type IssueStatus,
  type JobType,
  labels,
  projects,
  type ReleaseModel,
} from '../../db/schema.js';
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
  DEFAULT_NO_PROGRESS_ROUNDS,
  resolveNoProgressRounds,
} from '../../pipeline/reopen-policy.js';
import {
  PROJECT_FACTS_ALWAYS_INJECT_MAX_CHARS,
  type RESERVED_PROJECT_FACT_KEYS,
  selectAlwaysInjectFacts,
} from '../../projects/project-facts.js';
import {
  CANONICAL_LADDER,
  type FactRenderContext,
  FORGE_FACTS,
  type ForgeFact,
  getFact,
  type ProjectModuleFact,
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
  branches: { baseBranch: string | null; liveBranch: string | null; releaseModel: ReleaseModel };
  /** `pipelineConfig.reopenPolicy.noProgressRounds`, defaulted. Advisory —
   *  rendered into `## Project Config` for the agent to judge against. */
  noProgressRounds: number;
  /** Resolver for `{{project:<key>}}`. */
  project: ProjectVarResolver;
  /** Author-defined `agentConfig.projectFacts` keys (for dumping all guides). */
  projectFactKeys: string[];
  /** projectFacts flagged `alwaysInject` (ISS-521): rendered VERBATIM into the
   *  preamble (like a mandatory ForgeFact), and excluded from the
   *  fetch-on-demand guide index. Paired with their full text, in map order. */
  alwaysInjectFacts: Array<{ key: string; text: string }>;
  /** The project's `kind='module'` labels (ISS-595). Empty for a project with
   *  no taxonomy, which is what keeps `module-attribution` out of its prompt. */
  modules: ProjectModuleFact[];
}

interface TestingUrl {
  label?: string;
  url: string;
}

interface IntegrationRow {
  provider: string;
  role: BindingRole;
  stages: DeployStage[];
  lastHealthStatus: string | null;
  /** ISS-526 — Sentry-only: the labelled targets the agent picks between when
   *  querying the Sentry MCP (org/project is passed per call). */
  sentryTargets?: SentryTarget[];
  /** Operator text for THIS project's binding, rendered verbatim. */
  instructions?: string | null;
  /** The caller's org authored a runtime guide for this provider. */
  hasOrgGuide?: boolean;
}

export async function loadActiveIntegrationRows(
  projectId: string,
  orgId?: string | null,
): Promise<IntegrationRow[]> {
  const pairs = await listBindingsForProject(projectId);
  const active = pairs.filter((p) => p.binding.active && p.connection.active);
  if (active.length === 0) return [];

  const orgGuides = orgId ? await loadOrgGuideProviders(orgId) : new Set<string>();

  return active.map((p) => ({
    provider: p.binding.provider,
    role: p.binding.role,
    stages: (p.binding.stages ?? []) as DeployStage[],
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
    const guideSlug = r.hasOrgGuide
      ? integrationGuideSlug(r.provider)
      : getIntegrationGuide(r.provider);
    const guidePointer = guideSlug ? ` Full guide: \`forge_guide get ${guideSlug}\`.` : '';
    const scope = r.role === 'service' ? 'service' : r.stages.join('+') || 'deploy';
    const bullet = `- **${r.provider}** [${scope}]${health} — ${hint}${guidePointer}`;
    const extra: string[] = [];
    // ISS-526 — for Sentry, list the configured targets (label → org/project
    // → notes) under the bullet so the agent knows which org/project slug to
    // pass per Sentry MCP call. The MCP server still gets only host + token.
    if (r.provider === 'sentry' && r.sentryTargets && r.sentryTargets.length > 0) {
      extra.push(renderSentryTargetsLine(r.sentryTargets));
    }
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

/**
 * Build the project's happy-path ladder: the canonical sequence in
 * `registry.ts` as `CANONICAL_LADDER`, minus any stage the project disabled
 * via `pipelineConfig.states[s].enabled === false`. Pure.
 *
 * This is what `enabled` does, and all it does. Nothing skips at runtime, so
 * an omitted status is one the agent is not shown, never one the pipeline
 * routes around.
 */
function buildLadder(states: Record<string, { enabled?: boolean } | undefined>): IssueStatus[] {
  return CANONICAL_LADDER.filter((s) => states[s]?.enabled !== false);
}

/**
 * `{{project:<key>}}` resolver: reserved keys derive from first-class project
 * columns (`base-branch`, `live-branch`, `repo-path`, `test-urls`) plus a
 * security-safe pointer for `test-creds`; everything else reads the author's
 * `agentConfig.projectFacts` map. Pure.
 */
export function makeProjectResolver(src: {
  baseBranch: string | null;
  liveBranch: string | null;
  releaseModel: ReleaseModel;
  repoPath: string | null;
  testingUrls: TestingUrl[];
  testNotes: string | null;
  integrations: IntegrationRow[];
  projectFacts: Record<string, string>;
}): ProjectVarResolver {
  const reserved: Record<(typeof RESERVED_PROJECT_FACT_KEYS)[number], () => string | undefined> = {
    'base-branch': () => src.baseBranch ?? undefined,
    'live-branch': () =>
      src.releaseModel === 'promote' ? (src.liveBranch ?? undefined) : undefined,
    'production-branch': () =>
      '⚠️ `{{project:production-branch}}` was retired when a project gained a declared release model (ISS-1046). Use `{{project:live-branch}}`, which resolves only where the project declares `releaseModel: promote`. Update this skill body.',
    'repo-path': () => src.repoPath ?? undefined,
    'test-urls': () =>
      src.testingUrls.length > 0
        ? src.testingUrls.map((u) => `- ${u.label ? `${u.label}: ` : ''}${u.url}`).join('\n')
        : undefined,
    'test-creds': () =>
      'Fetch test credentials at runtime via `forge_projects.get` → `previewDeploy.testCredentials` (never hardcode secrets).',
    'test-notes': () => src.testNotes ?? undefined,
    integrations: () => renderIntegrations(src.integrations),
  };
  return (key) =>
    key in reserved ? reserved[key as keyof typeof reserved]() : src.projectFacts[key];
}

/**
 * The project's module taxonomy, flattened to names — the one input `module-attribution` gates on.
 *
 * Parent comes back as a NAME because the only consumer writes it into a system prompt, where an
 * id is noise an agent cannot act on: `forge_issues` resolves a module by name as well as by uuid.
 */
export async function loadProjectModules(projectId: string): Promise<ProjectModuleFact[]> {
  const parents = alias(labels, 'parent_labels');
  const rows = await db
    .select({ name: labels.name, parentName: parents.name })
    .from(labels)
    .leftJoin(parents, eq(labels.parentId, parents.id))
    .where(and(eq(labels.projectId, projectId), eq(labels.kind, 'module')))
    .orderBy(labels.name);
  return rows.map((r) => ({ name: r.name, parentName: r.parentName ?? null }));
}

/** Load the per-project inputs for fact resolution: the status ladder and the
 *  `{{project:}}` resolver (project columns + previewDeploy + connected
 *  integrations + the author's projectFacts map). */
export async function loadProjectFactInputs(projectId: string): Promise<ProjectFactInputs> {
  let states: Record<string, { enabled?: boolean } | undefined> = {};
  let projectFacts: Record<string, string> = {};
  let projectFactsConfig: Record<string, { alwaysInject?: boolean }> = {};
  let baseBranch: string | null = null;
  let liveBranch: string | null = null;
  let releaseModel: ReleaseModel = 'none';
  let repoPath: string | null = null;
  let testingUrls: TestingUrl[] = [];
  let testNotes: string | null = null;
  let integrations: IntegrationRow[] = [];
  let noProgressRounds = DEFAULT_NO_PROGRESS_ROUNDS;
  let modules: ProjectModuleFact[] = [];
  try {
    const [row] = await db
      .select({
        agentConfig: projects.agentConfig,
        previewDeploy: projects.previewDeploy,
        repoPath: projects.repoPath,
        baseBranch: projects.baseBranch,
        liveBranch: projects.liveBranch,
        releaseModel: projects.releaseModel,
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
    noProgressRounds = resolveNoProgressRounds(row?.agentConfig);
    projectFacts = ac?.projectFacts && typeof ac.projectFacts === 'object' ? ac.projectFacts : {};
    projectFactsConfig =
      ac?.projectFactsConfig && typeof ac.projectFactsConfig === 'object'
        ? ac.projectFactsConfig
        : {};
    const pd =
      (row?.previewDeploy as { testingUrls?: TestingUrl[]; notes?: string | null } | null) ?? null;
    testingUrls = Array.isArray(pd?.testingUrls) ? pd.testingUrls : [];
    testNotes = typeof pd?.notes === 'string' && pd.notes.length > 0 ? pd.notes : null;
    baseBranch = row?.baseBranch ?? null;
    liveBranch = row?.liveBranch ?? null;
    releaseModel = row?.releaseModel ?? 'none';
    repoPath = row?.repoPath ?? null;

    integrations = await loadActiveIntegrationRows(projectId, row?.orgId ?? null);
    modules = await loadProjectModules(projectId);
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
      alwaysInjectFacts = selectAlwaysInjectFacts(projectFacts, projectFactsConfig);
      projectFactKeys = Object.keys(projectFacts);
    }
  } else {
    alwaysInjectFacts = selectAlwaysInjectFacts(projectFacts, projectFactsConfig);
    projectFactKeys = Object.keys(projectFacts);
  }

  return {
    ladder: buildLadder(states),
    branches: { baseBranch, liveBranch, releaseModel },
    noProgressRounds,
    project: makeProjectResolver({
      baseBranch,
      liveBranch,
      releaseModel,
      repoPath,
      testingUrls,
      testNotes,
      integrations,
      projectFacts,
    }),
    projectFactKeys,
    alwaysInjectFacts,
    modules,
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
  const ctx: FactRenderContext = {
    projectId,
    stage,
    ladder: inputs.ladder,
    modules: inputs.modules,
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
  const { ladder, modules } = await loadProjectFactInputs(projectId);
  return { projectId, stage: stage ?? null, ladder, modules };
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
