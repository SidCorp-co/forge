import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { agentSessions } from '../../db/schema.js';
import { verifyUxScanAuthorization } from '../../projects/ux-scan-authorization.js';
import { applyUxScan, reserveUxScanGeneration } from '../../projects/ux-stack-apply.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsAdmin,
  resolveEffectiveProjectId,
  zodToMcpSchema,
} from './lib.js';

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
    authorization: z.string().min(1).max(4096).optional(),
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
    const authorization = input.authorization
      ? await verifyUxScanAuthorization(input.authorization)
      : undefined;
    if (authorization) {
      if (principal.kind !== 'device') {
        throw new Error('FORBIDDEN: delegated scan authorization requires its runner device');
      }
      if (authorization.projectId !== projectId) {
        throw new Error('FORBIDDEN: scan authorization is scoped to another project');
      }
      const [session] = await db
        .update(agentSessions)
        .set({
          metadata: sql`COALESCE(${agentSessions.metadata}, '{}'::jsonb) - 'authorizationId'`,
        })
        .where(
          and(
            eq(agentSessions.id, authorization.sessionId),
            eq(agentSessions.projectId, projectId),
            eq(agentSessions.userId, authorization.userId),
            eq(agentSessions.deviceId, principal.device.id),
            sql`${agentSessions.metadata} @> ${JSON.stringify({
              source: 'ux-scan',
              authorizationId: authorization.authorizationId,
            })}::jsonb`,
          ),
        )
        .returning({ id: agentSessions.id });
      if (!session) throw new Error('FORBIDDEN: scan authorization is no longer valid');
    } else {
      await assertPrincipalIsAdmin(principal, projectId);
    }

    const generation = authorization?.generation ?? (await reserveUxScanGeneration(projectId));
    const result = await applyUxScan(
      projectId,
      {
        packageDir: input.packageDir,
        dependencies: input.dependencies,
        filePaths: input.filePaths,
      },
      generation,
    );

    return {
      ok: true,
      mode: result.mode,
      detected: result.detected,
      proposed: result.proposed,
    };
  },
});
