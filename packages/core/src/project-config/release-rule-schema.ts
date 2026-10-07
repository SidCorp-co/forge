import { LANDING_SURFACES, type LandingSurface } from '@forge/contracts/landing-artifacts';
import { runtimePathPrefix } from '@forge/contracts/releases';
import { z } from 'zod';

const RUNTIME_PATH_SHAPE =
  'a path relative to the repository root, such as `packages/runner` or `packages/runner/`: no leading `/` or `./`, no `..` segment, no wildcard';

const RUNTIME_PATH_REFUSAL = `a release runtime path is ${RUNTIME_PATH_SHAPE}`;

const runtimePathSchema = z
  .string()
  .min(1, { message: RUNTIME_PATH_REFUSAL })
  .max(200, { message: `${RUNTIME_PATH_REFUSAL}, of at most 200 characters` })
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.startsWith('./') &&
      !/[*?[\]]/.test(p) &&
      p
        .split('/')
        .every(
          (segment, i, all) =>
            segment !== '..' && segment !== '.' && (segment !== '' || i === all.length - 1),
        ),
    { message: RUNTIME_PATH_REFUSAL },
  );

/**
 * ISS-1368 — a runtime a project's release is weighed against beside its deployment: the paths it
 * runs, and where what it serves is read from. `project-runners` is the build each of this
 * project's online runner devices reports, so it is for a project whose repository builds its own
 * runner. Absent, the deployment is the one runtime.
 */
const releaseRuntimesSchema = z
  .array(
    z.strictObject({
      name: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,39}$/, 'a lower-case name such as `runner`')
        .refine((n) => n !== 'deployment', {
          message: '`deployment` names the runtime every path no declared runtime claims',
        }),
      paths: z.array(runtimePathSchema).min(1).max(32),
      servedBy: z.enum(['project-runners']),
    }),
  )
  .max(8)
  .superRefine((runtimes, ctx) => {
    const names = new Set<string>();
    const owner = new Map<string, string>();
    runtimes.forEach((runtime, i) => {
      if (names.has(runtime.name)) {
        ctx.addIssue({
          code: 'custom',
          path: [i, 'name'],
          message: `two release runtimes are named \`${runtime.name}\`; each name is declared once`,
        });
      }
      names.add(runtime.name);
      runtime.paths.forEach((path, j) => {
        const prefix = runtimePathPrefix(path);
        for (const [held, by] of owner) {
          if (by !== runtime.name && (prefix.startsWith(held) || held.startsWith(prefix))) {
            ctx.addIssue({
              code: 'custom',
              path: [i, 'paths', j],
              message: `\`${path}\` overlaps \`${held}\`, which \`${by}\` already claims; a file runs in one release runtime, so no two paths may contain each other`,
            });
          }
        }
        owner.set(prefix, runtime.name);
      });
    });
  });
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
 * shown unclassified. Read by `release-batch/landing-surfaces.ts`.
 */
export const releaseSurfacesSchema = z.strictObject({
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

// read by `release-batch/approvals.ts` (approval), `release-batch/version.ts` (prerelease)
// and `release-batch/runtime-weighing.ts` (runtimes)
export const releaseRuleSchema = z.strictObject({
  approval: z.strictObject({ required: z.boolean() }),
  prerelease: z
    .strictObject({
      of: z.string().regex(/^\d{1,9}\.\d{1,9}\.\d{1,9}$/, 'MAJOR.MINOR.PATCH, e.g. 0.4.0'),
      label: z
        .string()
        .regex(/^[a-z][a-z0-9]{0,15}$/, 'a lower-case word of at most 16 characters, e.g. dev'),
    })
    .optional(),
  runtimes: releaseRuntimesSchema.optional(),
  surfaces: releaseSurfacesSchema.optional(),
});
