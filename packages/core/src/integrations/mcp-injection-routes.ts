/**
 * ISS-1038 — the one control for "does this integration reach agents".
 *
 * `GET  /:projectId/integrations/mcp-injection`            — any project member
 * `PUT  /:projectId/integrations/mcp-injection/:provider`  — org owner/admin
 *
 * The read is deliberately open to every member: the defect this issue was
 * filed on is an operator looking at a green panel that reaches nothing and
 * finding no screen that says why. A truth surface that only admins can load
 * would leave most of that complaint standing. Only the WRITE is gated, on
 * exactly the terms `PATCH /projects/:id/pipeline-config` is gated — same org
 * role, same `pipelineControl` flag — because it writes the same document, and
 * a second door into it with a weaker gate is a way around the first.
 *
 * The body is `{ enabled }` and the stored value is a bare `true`. No
 * credential passes through here: the provider's key stays in the integration
 * store and is rendered into a dispatch payload only.
 */
// cm:guard the write goes through `setMcpServerSentinel`, which changes one jsonb key in one statement. A read-modify-write of the whole `mcpServers` map from this handler would drop whatever another tab had just added — the affordance this route exists to avoid.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { assertOrgRoleOnProject, loadProjectAccess, orgRoleAtLeast } from '../lib/authz.js';
import { isEnabled } from '../lib/feature-flags.js';
import type { AuthVars } from '../middleware/auth.js';
import { setMcpServerSentinel } from '../pipeline/pipeline-config-service.js';
import { pipelineConfigHttpError } from '../projects/pipeline-config-http.js';
import {
  buildMcpInjectionState,
  isMcpInjectionProvider,
  MCP_INJECTION_PROVIDERS,
} from './mcp-injection-service.js';
import { badRequest, forbidden } from './route-helpers.js';

const bodySchema = z.object({ enabled: z.boolean() });

const flagOff = () =>
  new HTTPException(404, {
    message: 'pipeline configuration disabled',
    cause: { code: 'FEATURE_OFF' },
  });

export const mcpInjectionRoutes = new Hono<{ Variables: AuthVars }>();

mcpInjectionRoutes.get('/:projectId/integrations/mcp-injection', async (c) => {
  const projectId = c.req.param('projectId');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  if (!access.role) throw forbidden();

  return c.json({
    providers: await buildMcpInjectionState(projectId),
    // The server is the only party that knows the caller's org role, so the
    // control's enabled state comes from here rather than from anything the
    // client derives — a client-side guess can disagree with what the PUT
    // below will actually accept.
    canEdit: orgRoleAtLeast(access.orgRole, 'admin') && isEnabled('pipelineControl'),
  });
});

mcpInjectionRoutes.put('/:projectId/integrations/mcp-injection/:provider', async (c) => {
  if (!isEnabled('pipelineControl')) throw flagOff();

  const projectId = c.req.param('projectId');
  const provider = c.req.param('provider');
  const access = await loadProjectAccess(projectId, c.get('userId'));
  assertOrgRoleOnProject(access, 'admin', 'org admin required');

  // Refuse the name rather than absorbing it: a provider with no adapter
  // injects nothing, so storing its sentinel would write a key the dispatcher
  // sweeps away and leave the panel claiming a switch that does nothing.
  if (!isMcpInjectionProvider(provider)) {
    throw new HTTPException(400, {
      message: `no MCP injection adapter for provider '${provider}' — switchable providers are ${MCP_INJECTION_PROVIDERS.join(', ')}`,
      cause: {
        code: 'UNKNOWN_MCP_PROVIDER',
        details: { provider, known: [...MCP_INJECTION_PROVIDERS] },
      },
    });
  }

  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw badRequest(z.flattenError(parsed.error));

  try {
    await setMcpServerSentinel({ projectId, name: provider, enabled: parsed.data.enabled });
  } catch (err) {
    throw pipelineConfigHttpError(err);
  }

  return c.json({
    providers: await buildMcpInjectionState(projectId),
    canEdit: true,
  });
});
