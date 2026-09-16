/**
 * Which providers a binding may take `role: 'deploy'` on (ISS-1046).
 *
 * A capability, NOT a release-gate discriminator: it refuses a binding that could never BE a deploy
 * target, and never makes one a release target. What it must never grow into is a rule saying an
 * epodsystem binding IS a deploy — that is the project owner's declaration, and forge-dev carries
 * one purely to hand agents the storefront MCP.
 *
 * ## Why it is a module of its own, with its own subpath export
 *
 * Neither package can hold this for both sides. Core must not import a runtime value from
 * `@forge/contracts`: contracts is absent from core's production image, so such an import compiles
 * green and crashes at boot (`contracts-runtime-boundary.test.ts`). web-v2 must not import one from
 * `@forge/core/public`: that runs core's env validation at import time, which throws in a browser
 * build. So the list is mirrored in `core/src/integrations/types.ts` and held in lockstep by
 * `integrations/deploy-capability-parity.test.ts`.
 *
 * And it cannot live in `integrations.ts` beside the types, even though that is where it belongs by
 * subject. That module imports `@forge/core/public` for its types; the barrel `index.ts` re-exports
 * it; and the Next bundler cannot resolve core from a browser build, so the whole barrel resolves
 * to "no exports at all" and every runtime import through it is a module-not-found. This file
 * therefore imports NOTHING — which is the property that makes it safe, and the property to check
 * before adding anything to it. It is the fifth module of this kind here, beside
 * `failure-causes`, `pipeline-registry`, `issue-vocabulary` and `notifications`.
 *
 * The server is the check (`integrations/connection-routes.ts`, `integrations/binding-shape.ts`);
 * a screen reading this only spares the operator a round trip and lets the refusal name the
 * provider.
 */

export const DEPLOY_CAPABLE_PROVIDERS = ['coolify', 'epodsystem', 'agent'] as const;

export function providerCanDeploy(provider: string): boolean {
  return (DEPLOY_CAPABLE_PROVIDERS as readonly string[]).includes(provider);
}
