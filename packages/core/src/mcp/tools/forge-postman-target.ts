/**
 * ISS-336 — `forge_postman_target` MCP tool.
 *
 * Exposes the project's Postman WRITE-TARGET (workspace + collection + region
 * + mode) to skills running on a runner, so a skill knows where to write its
 * artifact. It deliberately returns NO API key — the key reaches the runner
 * only via the injected `mcpServers.postman` entry (see
 * `integrations/postman/resolver.ts`), never through this read surface.
 *
 * Returns `{ configured: false }` when the project has no active Postman
 * integration. Authorization is membership-level, like `forge_coolify_deploy`.
 */

import { z } from 'zod';
import {
  effectiveConfig,
  listActiveBindingsForProjectProvider,
} from '../../integrations/store.js';
import type { PostmanConfig } from '../../integrations/postman/types.js';
import {
  type ContextScopedMcpToolFactory,
  assertPrincipalIsMember,
  resolveProjectIdFromSlug,
  zodToMcpSchema,
} from './lib.js';

const inputSchema = z
  .object({
    projectId: z.uuid().optional(),
  })
  .strict();

type Input = z.infer<typeof inputSchema>;

export const forgePostmanTargetTool: ContextScopedMcpToolFactory = ({
  principal,
  projectSlug,
}) => ({
  name: 'forge_postman_target',
  description:
    "Return the project's Postman write-target so a skill knows WHERE to write its " +
    'collection/environment artifact. Resolves the single active postman integration for ' +
    'the project and returns { configured, workspaceId, workspaceName, collectionId, region, ' +
    'mode }. Returns { configured: false } when no active postman integration exists. ' +
    'NEVER returns the API key — the key is injected into the runner only via the ' +
    'mcpServers.postman entry. Project scope comes from the X-Forge-Project-Slug header ' +
    '(or an explicit projectId). Authorization: project membership.',
  inputSchema: zodToMcpSchema(inputSchema),
  handler: async (args) => {
    const input = inputSchema.parse(args) as Input;
    const projectId = input.projectId ?? (await resolveProjectIdFromSlug(projectSlug));
    await assertPrincipalIsMember(principal, projectId);

    const [pair] = await listActiveBindingsForProjectProvider(projectId, 'postman');
    if (!pair) return { configured: false };

    const config = effectiveConfig<PostmanConfig>(pair);
    return {
      configured: true,
      workspaceId: config.workspaceId ?? null,
      workspaceName: config.workspaceName ?? null,
      collectionId: config.collectionId ?? null,
      region: config.region ?? 'us',
      mode: config.mode ?? 'minimal',
    };
  },
});
