import { contentLanguageProblem } from '@forge/contracts/content-language';
import { hostOf } from '@forge/contracts/git-repository';
import { MCP_TOOL_NAMES } from '@forge/contracts/mcp-tools';
import type { ConfigRefusalCode } from '@forge/contracts/project-config';
import { resolveProjectTemplates } from '@forge/contracts/workflow-templates';
import type { PolicyDocument } from './policy-schema.js';
import {
  type BindingRole,
  type DeploymentTrigger,
  GITLESS_PROVIDERS,
  type ProjectDocument,
} from './schema.js';

export interface ConfigRefusal {
  code: ConfigRefusalCode;
  path: string;
  detail: string;
}

interface BindingFacts {
  role: BindingRole;
  provider: string;
  canDeploy: boolean;
  readsHistory: boolean;
}

export interface ProjectConfigContext {
  bindings: ReadonlyMap<string, BindingFacts>;
  testingProfileIds: ReadonlySet<string>;
  /** The diagram templates stored designs name (`id@version` → flows); absent, none is checked. */
  workflowTemplatesInUse?: ReadonlyMap<string, readonly string[]>;
  policy?: PolicyDocument;
}

function pointer(...segments: (string | number)[]): string {
  return segments.map((s) => `/${String(s).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

function listed(values: Iterable<string>): string {
  const all = [...values];
  return all.length === 0 ? '(none)' : all.join(', ');
}

/**
 * A gate names one host's checks. Only the two public hosts are told apart here, because a
 * self-hosted instance's name says nothing about which product serves it.
 */
const GATE_ON_THE_OTHER_HOST: Readonly<
  Record<string, { host: string; gate: string; reads: string }>
> = {
  'github-check': { host: 'gitlab.com', gate: 'gitlab-pipeline', reads: 'a GitHub check run' },
  'gitlab-pipeline': { host: 'github.com', gate: 'github-check', reads: 'a GitLab pipeline' },
};

function checkSourceShape(doc: ProjectDocument): ConfigRefusal[] {
  const out: ConfigRefusal[] = [];
  const type = doc.source.type;
  const isolation = doc.workspace.isolation;
  const needs =
    isolation === 'worktree' || isolation === 'branch'
      ? 'git'
      : isolation === 'remote-draft'
        ? 'storefront'
        : null;
  if (needs !== null && needs !== type) {
    out.push({
      code: 'ISOLATION_UNSUPPORTED',
      path: pointer('workspace', 'isolation'),
      detail: `isolation "${isolation}" needs source.type "${needs}", and this project's source.type is "${type}".`,
    });
  }
  const gate = doc.validation.gate.type;
  if (gate !== 'none' && type !== 'git') {
    out.push({
      code: 'GATE_UNSUPPORTED',
      path: pointer('validation', 'gate'),
      detail: `gate "${gate}" needs source.type "git", and this project's source.type is "${type}"; declare { "type": "none" } instead.`,
    });
  }
  if (gate !== 'none' && doc.source.type === 'git') {
    const host = hostOf(doc.source.git.repository);
    if (host === null) {
      out.push({
        code: 'GATE_UNSUPPORTED',
        path: pointer('validation', 'gate'),
        detail: `gate "${gate}" reads a host's checks, and this project's repository is the local path ${doc.source.git.repository}, which no host builds; declare { "type": "none" }, or declare the hosted repository.`,
      });
    }
    const other = GATE_ON_THE_OTHER_HOST[gate];
    if (other && host === other.host) {
      out.push({
        code: 'GATE_UNSUPPORTED',
        path: pointer('validation', 'gate'),
        detail: `gate "${gate}" reads ${other.reads}, and this project's repository is on ${host}, whose gate is "${other.gate}"; declare that instead.`,
      });
    }
  }
  if (doc.promotions.length > 0 && type !== 'git') {
    out.push({
      code: 'PROMOTIONS_NEED_GIT',
      path: pointer('promotions'),
      detail: `promotions cross git branches, and this project's source.type is "${type}"; promotions must be [].`,
    });
  }
  return out;
}

function findCycle(promotions: ProjectDocument['promotions']): string[] | null {
  const edges = new Map<string, string[]>();
  for (const p of promotions) edges.set(p.from, [...(edges.get(p.from) ?? []), p.to]);
  const done = new Set<string>();
  const walk = (node: string, trail: string[]): string[] | null => {
    const at = trail.indexOf(node);
    if (at >= 0) return [...trail.slice(at), node];
    if (done.has(node)) return null;
    for (const next of edges.get(node) ?? []) {
      const cycle = walk(next, [...trail, node]);
      if (cycle) return cycle;
    }
    done.add(node);
    return null;
  };
  for (const start of edges.keys()) {
    const cycle = walk(start, []);
    if (cycle) return cycle;
  }
  return null;
}

function checkBranches(doc: ProjectDocument): ConfigRefusal[] {
  if (doc.source.type !== 'git') return [];
  const out: ConfigRefusal[] = [];
  const { defaultBranch, branches } = doc.source.git;
  const declared = new Set(branches);
  if (!declared.has(defaultBranch)) {
    out.push({
      code: 'DEFAULT_BRANCH_UNDECLARED',
      path: pointer('source', 'git', 'defaultBranch'),
      detail: `"${defaultBranch}" is not in source.git.branches (${listed(branches)}).`,
    });
  }
  doc.promotions.forEach((p, i) => {
    for (const end of ['from', 'to'] as const) {
      if (!declared.has(p[end])) {
        out.push({
          code: 'PROMOTION_REF_UNDECLARED',
          path: pointer('promotions', i, end),
          detail: `"${p[end]}" is not in source.git.branches (${listed(branches)}).`,
        });
      }
    }
  });
  const cycle = findCycle(doc.promotions);
  if (cycle) {
    out.push({
      code: 'PROMOTION_CYCLE',
      path: pointer('promotions'),
      detail: `promotions form a cycle: ${cycle.join(' -> ')}.`,
    });
  }
  return out;
}

function checkBinding(
  id: string,
  want: BindingRole,
  path: string,
  ctx: ProjectConfigContext,
): ConfigRefusal[] {
  const found = ctx.bindings.get(id);
  if (!found) {
    return [
      {
        code: 'BINDING_NOT_FOUND',
        path,
        detail: `binding ${id} is not a binding of this project (bindings: ${listed(ctx.bindings.keys())}).`,
      },
    ];
  }
  if (found.role !== want) {
    return [
      {
        code: 'BINDING_ROLE_MISMATCH',
        path,
        detail: `binding ${id} has role "${found.role}", and this field needs role "${want}".`,
      },
    ];
  }
  return [];
}

/** A storefront source names its provider twice — in the document and on the binding — and both must agree. */
function checkStorefrontProvider(doc: ProjectDocument, ctx: ProjectConfigContext): ConfigRefusal[] {
  if (doc.source.type !== 'storefront') return [];
  const { provider, binding } = doc.source.storefront;
  const facts = ctx.bindings.get(binding);
  if (!facts || facts.provider === provider) return [];
  return [
    {
      code: 'BINDING_PROVIDER_MISMATCH',
      path: pointer('source', 'storefront', 'provider'),
      detail: `source.storefront.provider is "${provider}", and binding ${binding} is a ${facts.provider} binding; name "${facts.provider}" or bind a ${provider} storefront.`,
    },
  ];
}

/** A provider whose deliverable lives only on the provider has nothing a git branch could send it. */
function checkGitlessBindings(doc: ProjectDocument, ctx: ProjectConfigContext): ConfigRefusal[] {
  if (doc.source.type !== 'git') return [];
  const out: ConfigRefusal[] = [];
  for (const [name, env] of Object.entries(doc.environments)) {
    if (!('binding' in env.deployment)) continue;
    const facts = ctx.bindings.get(env.deployment.binding);
    if (!facts || !GITLESS_PROVIDERS.includes(facts.provider)) continue;
    out.push({
      code: 'GITLESS_BINDING_ON_GIT_SOURCE',
      path: pointer('environments', name, 'deployment', 'binding'),
      detail: `binding ${env.deployment.binding} is a ${facts.provider} binding, whose work lives on ${facts.provider} and in no repository, and this project's source.type is "git"; declare source {"type": "storefront", "storefront": {"provider": "${facts.provider}", ...}} with workspace.isolation "remote-draft".`,
    });
  }
  return out;
}

function checkTrigger(
  environment: string,
  trigger: DeploymentTrigger,
  bindingId: string,
  facts: BindingFacts,
): ConfigRefusal[] {
  const path = pointer('environments', environment, 'deployment', 'trigger');
  if (trigger === 'provider') {
    if (facts.readsHistory) return [];
    return [
      {
        code: 'TRIGGER_UNSUPPORTED',
        path,
        detail: `trigger "provider" leaves deploying to ${facts.provider}, and Forge cannot read ${facts.provider}'s deployment history through binding ${bindingId}, so it could never say what this environment runs; use deployment {"mode": "external"}.`,
      },
    ];
  }
  if (facts.canDeploy) return [];
  return [
    {
      code: 'TRIGGER_UNSUPPORTED',
      path,
      detail: `trigger "${trigger}" has Forge deploy through binding ${bindingId}, and Forge has no deploy adapter for ${facts.provider}; use trigger "provider" if ${facts.provider} deploys itself and Forge can read its history, or deployment {"mode": "external"}.`,
    },
  ];
}

function checkEnvironments(doc: ProjectDocument, ctx: ProjectConfigContext): ConfigRefusal[] {
  const out: ConfigRefusal[] = [];
  const envs = Object.entries(doc.environments);
  const production = envs.filter(([, e]) => e.tier === 'production').map(([n]) => n);
  if (production.length > 1) {
    out.push({
      code: 'PRODUCTION_NOT_UNIQUE',
      path: pointer('environments'),
      detail: `at most one environment may have tier "production"; these do: ${production.join(', ')}.`,
    });
  }
  const git = doc.source.type === 'git' ? doc.source.git : null;
  const holder = new Map<string, string>();
  for (const [name, env] of envs) {
    if (git && env.deploysFrom === undefined) {
      out.push({
        code: 'DEPLOYS_FROM_MISSING',
        path: pointer('environments', name),
        detail: `a git project's environment must name deploysFrom, one of ${listed(git.branches)}.`,
      });
    }
    if (git && env.deploysFrom !== undefined && !git.branches.includes(env.deploysFrom)) {
      out.push({
        code: 'DEPLOYS_FROM_UNDECLARED',
        path: pointer('environments', name, 'deploysFrom'),
        detail: `"${env.deploysFrom}" is not in source.git.branches (${listed(git.branches)}).`,
      });
    }
    if (!git && env.deploysFrom !== undefined) {
      out.push({
        code: 'DEPLOYS_FROM_NEEDS_GIT',
        path: pointer('environments', name, 'deploysFrom'),
        detail: `deploysFrom names a git branch, and this project's source.type is "${doc.source.type}"; remove it.`,
      });
    }
    if ('binding' in env.deployment) {
      const id = env.deployment.binding;
      const path = pointer('environments', name, 'deployment', 'binding');
      const bound = checkBinding(id, 'deploy', path, ctx);
      out.push(...bound);
      const facts = ctx.bindings.get(id);
      if (bound.length === 0 && facts) {
        out.push(...checkTrigger(name, env.deployment.trigger, id, facts));
      }
      const first = holder.get(id);
      if (first !== undefined) {
        out.push({
          code: 'BINDING_IN_USE',
          path,
          detail: `binding ${id} already deploys environment "${first}"; one deploy binding serves one environment.`,
        });
      } else {
        holder.set(id, name);
      }
    }
    if (env.testing !== undefined && !ctx.testingProfileIds.has(env.testing)) {
      out.push({
        code: 'TESTING_PROFILE_NOT_FOUND',
        path: pointer('environments', name, 'testing'),
        detail: `"${env.testing}" is not a testing profile of this project (profiles: ${listed(ctx.testingProfileIds)}).`,
      });
    }
  }
  return out;
}

const FORGE_TOOL_PREFIX = 'mcp__forge__';

// The grammar (schema.ts:TOOL_PATTERN) cannot see a Forge tool that does not exist; this server
// knows its own surface, and a deny entry naming no tool denies nothing, silently.
const FORGE_TOOLS: ReadonlySet<string> = new Set(
  MCP_TOOL_NAMES.map((name) => `${FORGE_TOOL_PREFIX}${name.replaceAll('.', '_')}`),
);

function checkDenyEntries(doc: PolicyDocument): ConfigRefusal[] {
  const out: ConfigRefusal[] = [];
  for (const [profile, { deny }] of Object.entries(doc.permissions)) {
    deny.forEach((entry, i) => {
      if (!entry.startsWith(FORGE_TOOL_PREFIX) || entry === `${FORGE_TOOL_PREFIX}*`) return;
      if (FORGE_TOOLS.has(entry)) return;
      out.push({
        code: 'TOOL_PATTERN_INVALID',
        path: pointer('permissions', profile, 'deny', i),
        detail: `"${entry}" names no tool this Forge server registers, so denying it denies nothing; a Forge tool is ${FORGE_TOOL_PREFIX}<tool> with the tool's dots as underscores, e.g. ${FORGE_TOOL_PREFIX}forge_coolify_deploy.`,
      });
    });
  }
  return out;
}

export function checkPolicy(doc: PolicyDocument): ConfigRefusal[] {
  const out: ConfigRefusal[] = checkDenyEntries(doc);
  const profiles = Object.keys(doc.permissions);
  for (const [status, state] of Object.entries(doc.states)) {
    if (state && !Object.hasOwn(doc.permissions, state.permissions)) {
      out.push({
        code: 'PERMISSION_PROFILE_UNDEFINED',
        path: pointer('states', status, 'permissions'),
        detail: `"${state.permissions}" is not a profile in permissions (${listed(profiles)}).`,
      });
    }
  }
  return out;
}

// cm:guard ctx.policy is checked too, so a caller passing it is never silently ignored; its
// refusal paths point into the policy document, not the project document.
export function checkProjectConfig(
  doc: ProjectDocument,
  ctx: ProjectConfigContext,
): ConfigRefusal[] {
  const out = [...checkSourceShape(doc), ...checkBranches(doc)];
  if (doc.source.type === 'storefront') {
    out.push(
      ...checkBinding(
        doc.source.storefront.binding,
        'source',
        pointer('source', 'storefront', 'binding'),
        ctx,
      ),
    );
  }
  out.push(...checkStorefrontProvider(doc, ctx));
  out.push(...checkEnvironments(doc, ctx));
  out.push(...checkGitlessBindings(doc, ctx));
  out.push(...checkWorkflowTemplates(doc, ctx));
  out.push(...checkContentLanguage(doc));
  out.push(...checkRetiredApprovers(doc));
  if (ctx.policy) out.push(...checkPolicy(ctx.policy));
  return out;
}

// cm:why a project template is policy over the kernel's built-ins: each is held to the same
// meta-schema and consistency as a built-in, and one a stored design is drawn in cannot be taken
// out from under it — that design would be read in a vocabulary nobody declares any more
function checkWorkflowTemplates(
  doc: Pick<ProjectDocument, 'workflows'>,
  ctx: Pick<ProjectConfigContext, 'workflowTemplatesInUse'>,
): ConfigRefusal[] {
  const resolved = resolveProjectTemplates(doc.workflows?.templates ?? []);
  const out: ConfigRefusal[] = resolved.refusals.map((r) => ({ ...r }));
  const declared = new Set(resolved.templates.map((t) => `${t.id}@${t.version}`));
  for (const [key, flows] of ctx.workflowTemplatesInUse ?? []) {
    if (declared.has(key)) continue;
    out.push({
      code: 'WORKFLOW_TEMPLATE_IN_USE',
      path: pointer('workflows', 'templates'),
      detail: `template ${key} is no longer declared, and ${listed(flows)} ${flows.length === 1 ? 'is' : 'are'} drawn in it; keep it, or rewrite ${flows.length === 1 ? 'that design' : 'those designs'} in another template first.`,
    });
  }
  return out;
}

const RETIRED_APPROVERS = [
  ['workflows', 'designApprover', 'workflow-designs.approve'],
  ['contracts', 'approver', 'contracts.approve'],
] as const;

// Approval is a permission (ADR 0007): a write naming the person-or-master knob is refused by name,
// so nobody sets a policy that no longer decides anything.
function checkRetiredApprovers(
  doc: Pick<ProjectDocument, 'workflows' | 'contracts'>,
): ConfigRefusal[] {
  return RETIRED_APPROVERS.flatMap(([section, key, permission]) => {
    const held = (doc[section] as Record<string, unknown> | undefined)?.[key];
    if (held === undefined) return [];
    return [
      {
        code: 'APPROVER_POLICY_RETIRED' as const,
        path: pointer(section, key),
        detail: `${section}.${key} is retired: who decides is whoever holds ${permission} on the project (project admin, or an org owner or admin), person or agent alike. Remove the key.`,
      },
    ];
  });
}

// cm:guard a tag that names no language is refused by name: a prompt told to write in it could only
// guess. The language of what is written is never checked (VISION: kernel-hard-policy-soft).
export function checkContentLanguage(
  doc: Pick<ProjectDocument, 'contentLanguage'>,
): ConfigRefusal[] {
  if (doc.contentLanguage === undefined) return [];
  const problem = contentLanguageProblem(doc.contentLanguage);
  return problem === null
    ? []
    : [{ code: 'CONTENT_LANGUAGE_INVALID', path: pointer('contentLanguage'), detail: problem }];
}
