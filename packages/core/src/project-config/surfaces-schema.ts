import { LANDING_SURFACES, type LandingSurface } from '@forge/contracts/landing-artifacts';
import { z } from 'zod';

const SURFACE_GLOB_SHAPE =
  'a glob relative to the repository root, such as `packages/web-v2/**` or `packages/core/src/**/*routes.ts`: no leading `/` or `./`, no `..` segment';

const surfaceGlobSchema = z
  .string()
  .min(1, { message: `a surface path is ${SURFACE_GLOB_SHAPE}` })
  .max(200, { message: `a surface path is ${SURFACE_GLOB_SHAPE}, of at most 200 characters` })
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.startsWith('./') &&
      p.split('/').every((segment) => segment !== '..' && segment !== '.'),
    { message: `a surface path is ${SURFACE_GLOB_SHAPE}` },
  );

/** `design` is what a design revision lands as; no changed path is one. */
export const MAPPED_SURFACES = LANDING_SURFACES.filter(
  (s): s is Exclude<LandingSurface, 'design'> => s !== 'design',
);

/**
 * Which surface each changed path of a git landing touches: the first rule whose glob matches a
 * path names it, `ignore` names paths that ship nothing (docs, tests), and a path neither claims is
 * shown unclassified. A project declaring none has its changed paths shown as they are. Read by
 * `release-batch/landing-surfaces.ts`; forge-core's own map is
 * `packages/core/tests/fixtures/forge-core-surfaces.json`.
 */
export const surfacesSchema = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        surface: z.enum(MAPPED_SURFACES, {
          error: (issue) =>
            `surface ${JSON.stringify(issue.input)} cannot be mapped from a path: it is one of ${MAPPED_SURFACES.map((s) => `\`${s}\``).join(', ')} (\`design\` is a design revision's, never a path's)`,
        }),
        paths: z.array(surfaceGlobSchema).min(1).max(32),
      }),
    )
    .min(1)
    .max(16),
  ignore: z.array(surfaceGlobSchema).max(32).optional(),
});
