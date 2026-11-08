// Which Coolify bindings reach a production site's box, and which of them deploy with no person's
// confirm (ISS-1077: each production site by its own trigger).

import type { DeployMap } from '../project-config/index.js';

/**
 * Whether a deploy reaching production goes out with no person's confirm (ISS-1077): a production
 * site's own binding by its own trigger, so each site keeps its own rule; a binding that reaches
 * production only by sharing its application, where every site of production deploys on land.
 */
export async function deploysItselfOnLand(
  map: DeployMap,
  binding: { id: string },
  everySiteOnLand: () => Promise<boolean>,
): Promise<boolean> {
  const site = map.productionBindings.has(binding.id)
    ? map.environments.get(binding.id)
    : undefined;
  return site ? site.trigger === 'on-land' : await everySiteOnLand();
}

/**
 * Which of these bindings reach the production box — by being a production site's binding, or by
 * deploying to an application such a binding also deploys to.
 *
 * Built from the WHOLE binding set before any filter, because the shared resource is only
 * visible while the production binding is still in the list: drop it first and the one beside
 * it stops looking like production — measured on forge-dev, whose two deploy bindings both
 * target `y8w4c4kss8ogo8gc44ow44kc`.
 */
export function reachesProductionOf(
  map: DeployMap,
  pairs: ReadonlyArray<{ binding: { id: string; config: unknown } }>,
): (binding: { id: string; config: unknown }) => boolean {
  const live = new Set(
    pairs
      .filter((p) => map.productionBindings.has(p.binding.id))
      .flatMap((p) => resourceUuidsOf(p.binding.config)),
  );
  return (binding) =>
    map.productionBindings.has(binding.id) ||
    resourceUuidsOf(binding.config).some((u) => live.has(u));
}

/** The Coolify applications a binding's config names, however sparse it is. */
export function resourceUuidsOf(config: unknown): string[] {
  const targets = (config as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(targets)) return [];
  return targets
    .map((t) => (t as { resourceUuid?: unknown })?.resourceUuid)
    .filter((u): u is string => typeof u === 'string' && u.length > 0);
}
