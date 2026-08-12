import { z } from 'zod';
import { applyUxScan } from '../../projects/ux-stack-apply.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsAdmin,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

// ISS-576 — the runner→core seam for the UX Contract auto-detect scan. Core
// has no repo checkout (see `projects/ux-stack-scan.ts` header), so an agent
// turn on a runner collects the snapshot (package.json deps + `git ls-files`)
// and posts it here; core does the deterministic detection + persistence.

const MAX_FILE_PATHS = 4000;
const MAX_FILE_PATH_CHARS = 400;
const MAX_DEPENDENCIES = 500;

const PACKAGE_DIR_RE = /^[A-Za-z0-9._/-]{1,200}$/;

const packageDirSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (dir) =>
      PACKAGE_DIR_RE.test(dir) &&
      !dir.startsWith('/') &&
      !dir.startsWith('-') &&
      !dir.split('/').includes('..'),
    { message: 'must be a repo-relative path with no ".." segments' },
  );

const inputSchema = z
  .object({
    projectId: z.uuid().optional(),
    packageDir: packageDirSchema,
    dependencies: z
      .record(z.string().max(200), z.string().max(200))
      .refine((dependencies) => Object.keys(dependencies).length <= MAX_DEPENDENCIES, {
        message: `must contain at most ${MAX_DEPENDENCIES} dependencies`,
      }),
    filePaths: z.array(z.string().max(MAX_FILE_PATH_CHARS)).max(MAX_FILE_PATHS),
  })
  .strict();

export const forgeUxScanTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ux_scan',
  description:
    'Submit a UX stack snapshot ({packageDir, dependencies, filePaths}) collected from the repo checkout; ' +
    'core runs the deterministic design-system detector and persists the result. ' +
    'Do not interpret the stack yourself — the server does the detection. ' +
    'Returns {ok:true, mode:"created"|"proposed"|"unchanged", detected, proposed} on success. ' +
    'Requires project admin access; malformed or oversized snapshots are rejected before processing.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await assertPrincipalIsAdmin(principal, projectId);

    const result = await applyUxScan(projectId, {
      packageDir: input.packageDir,
      dependencies: input.dependencies,
      filePaths: input.filePaths,
    });

    return {
      ok: true,
      mode: result.mode,
      detected: result.detected,
      proposed: result.proposed,
    };
  },
});
