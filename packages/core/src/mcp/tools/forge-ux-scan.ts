import { z } from 'zod';
import { applyUxScan } from '../../projects/ux-stack-apply.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsWriter,
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

const inputSchema = z
  .object({
    projectId: z.uuid().optional(),
    packageDir: z.string().trim().min(1).max(200),
    dependencies: z.record(z.string(), z.string()),
    filePaths: z.array(z.string().max(MAX_FILE_PATH_CHARS)),
  })
  .strict();

export const forgeUxScanTool: ContextScopedMcpToolFactory = (ctx) => ({
  name: 'forge_ux_scan',
  description:
    'Submit a UX stack snapshot ({packageDir, dependencies, filePaths}) collected from the repo checkout; ' +
    'core runs the deterministic design-system detector and persists the result. ' +
    'Do not interpret the stack yourself — the server does the detection. ' +
    'Returns {ok:true, mode:"created"|"proposed"|"unchanged", detected, proposed} on success; ' +
    '{ok:false, reason:"too_many_dependencies"|"too_many_file_paths"} when a payload cap is exceeded.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args);
    const { principal } = ctx;

    const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
    await assertPrincipalIsWriter(principal, projectId);

    if (Object.keys(input.dependencies).length > MAX_DEPENDENCIES) {
      return {
        ok: false,
        reason: 'too_many_dependencies',
        limit: MAX_DEPENDENCIES,
      };
    }
    if (input.filePaths.length > MAX_FILE_PATHS) {
      return {
        ok: false,
        reason: 'too_many_file_paths',
        limit: MAX_FILE_PATHS,
      };
    }

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
