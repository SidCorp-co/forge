// An environment's `routes` (ISS-470): the path prefixes each declared service answers, so a kept
// request probe is replayed on the origin that answers its path. The schema
// (`schema.ts:environmentSchema`) holds each route to a declared service and each prefix to one.

import type { z } from 'zod';

interface RoutedEnvironment {
  services?: Record<string, string> | undefined;
  routes?: Record<string, string[]> | undefined;
}

/** A route naming a service `services` does not declare, or a prefix two services claim. */
export function routesFaults(env: RoutedEnvironment, ctx: z.RefinementCtx): void {
  const declared = new Set(Object.keys(env.services ?? {}));
  const owners = new Map<string, string>();
  for (const [service, prefixes] of Object.entries(env.routes ?? {})) {
    if (!declared.has(service)) {
      ctx.addIssue({
        code: 'custom',
        path: ['routes', service],
        message: `routes names service \`${service}\`, which \`services\` does not declare`,
      });
    }
    for (const prefix of prefixes) {
      const other = owners.get(prefix);
      if (other !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', service],
          message: `prefix \`${prefix}\` is routed by both \`${other}\` and \`${service}\``,
        });
      }
      owners.set(prefix, service);
    }
  }
}
