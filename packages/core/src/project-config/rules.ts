import { REGISTERED_TOOLS } from '../mcp/registered-tools.js';
import type { BindingRole, PolicyDocument, ProjectDocument } from './schema.js';

// cm:why enumerating is the point: this list IS the refusal vocabulary callers switch on.
export const PURE_REFUSAL_CODES = [
  'DEFAULT_BRANCH_UNDECLARED',
  'PROMOTIONS_NEED_GIT',
  'PROMOTION_REF_UNDECLARED',
  'PROMOTION_CYCLE',
  'DEPLOYS_FROM_MISSING',
  'DEPLOYS_FROM_UNDECLARED',
  'DEPLOYS_FROM_NEEDS_GIT',
  'PRODUCTION_NOT_UNIQUE',
  'ISOLATION_UNSUPPORTED',
  'GATE_UNSUPPORTED',
  'BINDING_NOT_FOUND',
  'BINDING_ROLE_MISMATCH',
  'BINDING_IN_USE',
  'TESTING_PROFILE_NOT_FOUND',
  'PERMISSION_PROFILE_UNDEFINED',
  'TOOL_PATTERN_INVALID',
] as const;

// cm:why these need storage, a registry or the request; S2 implements them. UNKNOWN_KEY is the
// strict schema's own unrecognized_keys issue, named here so the API maps it to one code.
export const STORED_REFUSAL_CODES = [
  'UNKNOWN_KEY',
  'VERSION_UNSUPPORTED',
  'STALE_BASE',
  'PROJECT_ID_IMMUTABLE',
  'SLUG_TAKEN',
  'TRIGGER_UNSUPPORTED',
  'CONNECTION_NOT_FOUND',
  'CONNECTION_PROVIDER_MISMATCH',
  'SECRET_NOT_FOUND',
] as const;

export const CONFIG_REFUSAL_CODES = [...PURE_REFUSAL_CODES, ...STORED_REFUSAL_CODES] as const;

export type ConfigRefusalCode = (typeof CONFIG_REFUSAL_CODES)[number];

export interface ConfigRefusal {
  code: ConfigRefusalCode;
  path: string;
  detail: string;
}

export interface ProjectConfigContext {
  bindings: ReadonlyMap<string, { role: BindingRole }>;
  testingProfileIds: ReadonlySet<string>;
  policy?: PolicyDocument;
}

function pointer(...segments: (string | number)[]): string {
  return segments.map((s) => `/${String(s).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

function listed(values: Iterable<string>): string {
  const all = [...values];
  return all.length === 0 ? '(none)' : all.join(', ');
}

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
  if (doc.validation.gate.type === 'github-check' && type !== 'git') {
    out.push({
      code: 'GATE_UNSUPPORTED',
      path: pointer('validation', 'gate'),
      detail: `gate "github-check" needs source.type "git", and this project's source.type is "${type}"; declare { "type": "none" } instead.`,
    });
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
      out.push(...checkBinding(id, 'deploy', path, ctx));
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

// cm:why the grammar (schema.ts:TOOL_PATTERN) cannot see a Forge tool that does not exist; this
// server knows its own surface, and a deny entry naming no tool denies nothing, silently.
const FORGE_TOOLS: ReadonlySet<string> = new Set(
  REGISTERED_TOOLS.map((name) => `${FORGE_TOOL_PREFIX}${name.replaceAll('.', '_')}`),
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
        detail: `"${entry}" names no tool this Forge server registers, so denying it denies nothing; a Forge tool is ${FORGE_TOOL_PREFIX}<tool> with the tool's dots as underscores, e.g. ${FORGE_TOOL_PREFIX}forge_jobs_cancel.`,
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
  out.push(...checkEnvironments(doc, ctx));
  if (ctx.policy) out.push(...checkPolicy(ctx.policy));
  return out;
}
