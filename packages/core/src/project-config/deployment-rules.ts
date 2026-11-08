// The rules each deployment an environment declares is held to at write: what its binding's provider
// can do, and (ISS-1077) the sites of a production of several: only production names sites, each under
// a name no environment or other site has, and every site deploys through a binding.

import { withArticle } from '@forge/contracts/articles';
import { jsonPointer } from '../lib/refusal.js';
import type { BindingFacts, ConfigRefusal, ProjectConfigContext } from './rules.js';
import {
  type DeploymentTrigger,
  type EnvironmentDeclaration,
  GITLESS_PROVIDERS,
  type ProjectDocument,
} from './schema.js';

const pointer = (...segments: (string | number)[]): string => jsonPointer(segments);

type Deployment = EnvironmentDeclaration['deployment'];

/** Each deployment an environment declares, at its path: its own, then each site's (ISS-1077). */
export function deploymentsOf(
  name: string,
  env: EnvironmentDeclaration,
): { deployment: Deployment; at: (string | number)[]; site: string }[] {
  return [
    { deployment: env.deployment, at: ['environments', name, 'deployment'], site: name },
    ...(env.sites ?? []).map((s, i) => ({
      deployment: s.deployment,
      at: ['environments', name, 'sites', i, 'deployment'],
      site: s.name,
    })),
  ];
}

/**
 * A production of several sites (ISS-1077): only production names sites, each under its own name,
 * and every site, the environment's own included, deploys through a binding of its own; a binding
 * two sites name is BINDING_IN_USE (`checkEnvironments`).
 */
export function checkSites(
  name: string,
  env: EnvironmentDeclaration,
  environments: readonly string[],
): ConfigRefusal[] {
  const sites = env.sites;
  if (sites === undefined) return [];
  if (env.tier !== 'production') {
    return [
      {
        code: 'SITES_NEED_PRODUCTION',
        path: pointer('environments', name, 'sites'),
        detail: `environment "${name}" has tier "${env.tier}", and only the production environment names further sites; declare another environment for it instead.`,
      },
    ];
  }
  const out: ConfigRefusal[] = [];
  // a site's name is the box its deploy holds (`release-coolify.ts:deployTargets`), so it is unique
  // among the project's environments as well as its sites
  const seen = new Set(environments);
  sites.forEach((site, i) => {
    if (seen.has(site.name)) {
      const what =
        site.name === name
          ? `environment "${name}"'s own deployment, the site named by the environment`
          : environments.includes(site.name)
            ? `environment "${site.name}"`
            : `another site of environment "${name}"`;
      out.push({
        code: 'PRODUCTION_SITE_NAME_TAKEN',
        path: pointer('environments', name, 'sites', i, 'name'),
        detail: `site "${site.name}" names ${what}; each site has a name no environment or other site has.`,
      });
    }
    seen.add(site.name);
  });
  for (const { deployment, at, site } of deploymentsOf(name, env)) {
    if ('binding' in deployment) continue;
    out.push({
      code: 'PRODUCTION_SITE_UNBOUND',
      path: pointer(...at),
      detail: `site "${site}" of environment "${name}" is deployed outside Forge, and a production of several sites deploys each through a binding of its own, so every release can deploy, judge and record it; give it {"binding": "<uuid>", "trigger": "on-request"}.`,
    });
  }
  return out;
}

/** A provider whose deliverable lives only on the provider has nothing a git branch could send it. */
export function checkGitlessBindings(
  doc: ProjectDocument,
  ctx: ProjectConfigContext,
): ConfigRefusal[] {
  if (doc.source.type !== 'git') return [];
  const out: ConfigRefusal[] = [];
  for (const [name, env] of Object.entries(doc.environments)) {
    for (const { deployment, at } of deploymentsOf(name, env)) {
      if (!('binding' in deployment)) continue;
      const facts = ctx.bindings.get(deployment.binding);
      if (!facts || !GITLESS_PROVIDERS.includes(facts.provider)) continue;
      out.push({
        code: 'GITLESS_BINDING_ON_GIT_SOURCE',
        path: pointer(...at, 'binding'),
        detail: `binding ${deployment.binding} is ${withArticle(facts.provider)} binding, whose work lives on ${facts.provider} and in no repository, and this project's source.type is "git"; declare source {"type": "storefront", "storefront": {"provider": "${facts.provider}", ...}} with workspace.isolation "remote-draft".`,
      });
    }
  }
  return out;
}

export function checkTrigger(
  at: (string | number)[],
  trigger: DeploymentTrigger,
  bindingId: string,
  facts: BindingFacts,
): ConfigRefusal[] {
  const path = pointer(...at, 'trigger');
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
