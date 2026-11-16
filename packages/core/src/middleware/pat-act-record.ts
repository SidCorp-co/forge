/**
 * Every act a personal or agent access token makes over REST is recorded against that token
 * (REQ-27 BC-2): one `mcp_audit_log` row per write request, as each MCP tool call already is,
 * naming the token, its device, the route acted on, the project the path names and how the act
 * ended. A read is not an act and writes none. A request passes several routers' auth gates, so the
 * row is written once, by the first gate to see the answer. An act on a box credential also names the
 * session it was made in, as the box's reads do, so a master's and a run's acts are told apart though
 * one credential serves both (ISS-1251).
 */

import { RUN_CONTEXT_RUN_HEADER } from '@forge/contracts/run-context';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auditResultOf, refusalCodeOfBody, writeMcpAudit } from '../credentials/mcp-audit.js';
import { fencedProjectIds } from '../credentials/pat-scope.js';
import { actSessionOf } from '../credentials/ports.js';
import { logger } from '../lib/logger.js';
import { scopeForMethod } from './pat-rest-surface.js';
import { getClientIp } from './rate-limit.js';
import type { PatPrincipal } from './require-pat.js';

const RECORDED_VAR = 'patActRecorded';
const PROJECT_IN_PATH =
  /\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/**
 * The code a refused answer carries in its body (ISS-1251), read off a copy after the answer is set,
 * so the request is never held for it; null for an answer that is not JSON or names no code.
 */
function refusalCodeOf(res: Response | undefined): Promise<string | null> {
  if (!res || !(res.headers.get('content-type') ?? '').includes('json')) {
    return Promise.resolve(null);
  }
  return res
    .clone()
    .json()
    .then(refusalCodeOfBody, () => null);
}

/** The project a path names, or null. */
export function projectOfPath(path: string): string | null {
  return PROJECT_IN_PATH.exec(path)?.[1]?.toLowerCase() ?? null;
}

/**
 * The session a box credential's act was made in: the run the call names (`x-forge-run`), else as
 * the box's reads are named; null for a credential on no box, an act in no one project, or a box
 * running several sessions the call names none of. A failure to name it never fails the record.
 */
function sessionOfAct(c: Context, principal: PatPrincipal): Promise<string | null> {
  const fence = fencedProjectIds();
  const projectId = projectOfPath(c.req.path) ?? (fence?.length === 1 ? (fence[0] ?? null) : null);
  if (!principal.deviceId || !projectId) return Promise.resolve(null);
  const caller = {
    deviceId: principal.deviceId,
    tokenId: principal.tokenId,
    projectId,
    fence,
    asked: c.req.header(RUN_CONTEXT_RUN_HEADER)?.trim() || null,
  };
  // named after the answer, off the request's path: a throw here never reaches the act
  return Promise.resolve()
    .then(() => actSessionOf(caller))
    .catch((err: unknown) => {
      logger.warn(
        { err, projectId, deviceId: caller.deviceId },
        'pat-act: the session an act was made in could not be named; it counts under its credential',
      );
      return null;
    });
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
        resultCode: auditResultOf(status ?? 500),
        refusalCode: (status ?? 500) >= 400 ? refusalCodeOf(c.res) : null,
        agentSessionId: sessionOfAct(c, principal),
        ip: getClientIp(c) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
    }
  }
}
