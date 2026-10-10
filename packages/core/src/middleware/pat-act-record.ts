/**
 * Every act a personal or agent access token makes over REST is recorded against that token
 * (REQ-27 BC-2): one `mcp_audit_log` row per write request, as each MCP tool call already is,
 * naming the token, its device, the route acted on, the project the path names and how the act
 * ended. A read is not an act and writes none. A request passes several routers' auth gates, so the
 * row is written once, by the first gate to see the answer.
 */

import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { type AuditResultCode, writeMcpAudit } from '../credentials/mcp-audit.js';
import { scopeForMethod } from './pat-rest-surface.js';
import { getClientIp } from './rate-limit.js';
import type { PatPrincipal } from './require-pat.js';

const RECORDED_VAR = 'patActRecorded';
const PROJECT_IN_PATH =
  /\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/** How an act ended, from the status it was answered with. */
export function actResultOf(status: number): AuditResultCode {
  if (status < 400) return 'ok';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'error';
}

/** The project a path names, or null. */
export function projectOfPath(path: string): string | null {
  return PROJECT_IN_PATH.exec(path)?.[1]?.toLowerCase() ?? null;
}

/** Run the rest of the request, then record it against the token when it was a write. */
export async function recordingPatAct(
  c: Context,
  principal: PatPrincipal,
  next: () => Promise<void>,
): Promise<void> {
  let status: number | null = null;
  try {
    await next();
    status = c.res.status;
  } catch (err) {
    status = err instanceof HTTPException ? err.status : 500;
    throw err;
  } finally {
    if (scopeForMethod(c.req.method) === 'write' && !c.get(RECORDED_VAR)) {
      c.set(RECORDED_VAR, true);
      writeMcpAudit({
        userId: principal.userId,
        tokenId: principal.tokenId,
        deviceId: principal.deviceId ?? null,
        tool: 'rest',
        action: `${c.req.method} ${c.req.path}`.slice(0, 500),
        projectId: projectOfPath(c.req.path),
        resultCode: actResultOf(status ?? 500),
        ip: getClientIp(c) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
    }
  }
}
