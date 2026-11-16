import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { mcpAuditLog } from '../db/schema.js';
import { background } from '../lib/background.js';

export type AuditResultCode =
  | 'ok'
  | 'forbidden'
  | 'not_found'
  | 'error'
  | 'revoked'
  | 'rate_limited';

interface AuditRow {
  userId: string | null;
  tokenId: string | null;
  deviceId: string | null;
  tool: string;
  action?: string | null;
  projectId?: string | null;
  resultCode: AuditResultCode;
  /**
   * The code a refused call answered with (ISS-1251): read off the refusal itself, or off the
   * answer's body where it is only known once the body is read; null where it ended ok.
   */
  refusalCode?: string | null | Promise<string | null>;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payloadDigest?: string | null;
}

/**
 * Stable sha256 of canonicalised args. Keys are sorted so `{a:1,b:2}` and
 * `{b:2,a:1}` produce the same digest. Returns `null` when args is empty
 * to keep the column non-noisy.
 */
export function digestArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const sortedJson = JSON.stringify(args, Object.keys(args as object).sort());
  if (sortedJson === '{}' || sortedJson === 'null') return null;
  return createHash('sha256').update(sortedJson).digest('hex');
}

/** How an act ended, from the status it was answered with. */
export function auditResultOf(status: number): AuditResultCode {
  if (status < 400) return 'ok';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'error';
}

const CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/;

/**
 * The code a refusal answered with, read off its body as both doors write it (`lib/refusal.ts`): the
 * envelope's `code`, else its `error.code`; null where the body carries none.
 */
export function refusalCodeOfBody(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { code, error } = body as { code?: unknown; error?: { code?: unknown } | null };
  const found = typeof code === 'string' ? code : error?.code;
  return typeof found === 'string' && CODE.test(found) ? found : null;
}

/**
 * How a door's answer ends on the log: a refusal it answered (`_mcpIsError`, the envelope both doors
 * write) is a refused call under its status's outcome and its code, never an ok (ISS-1251).
 */
export function answeredAudit(answer: unknown): {
  resultCode: AuditResultCode;
  refusalCode: string | null;
} {
  const refused =
    typeof answer === 'object' &&
    answer !== null &&
    (answer as { _mcpIsError?: unknown })._mcpIsError === true;
  if (!refused) return { resultCode: 'ok', refusalCode: null };
  const status = Number((answer as { status?: unknown }).status);
  return {
    resultCode: auditResultOf(Number.isInteger(status) && status >= 400 ? status : 400),
    refusalCode: refusalCodeOfBody(answer),
  };
}

const audits = background();

/** Writes the audit row after the response, never failing the request it records. */
export function writeMcpAudit(row: AuditRow): void {
  audits.start(
    async () =>
      db.insert(mcpAuditLog).values({
        userId: row.userId,
        tokenId: row.tokenId,
        deviceId: row.deviceId,
        tool: row.tool,
        action: row.action ?? null,
        projectId: row.projectId ?? null,
        resultCode: row.resultCode,
        refusalCode: (await row.refusalCode) ?? null,
        requestId: row.requestId ?? null,
        ip: row.ip ?? null,
        userAgent: row.userAgent ?? null,
        payloadDigest: row.payloadDigest ?? null,
      }),
    (err) => console.warn('[mcp-audit] insert failed', err),
  );
}
