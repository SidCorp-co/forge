// ctx.forge.get's host (REQ-37 BC-2..BC-7, BC-9): a script reads Forge by GET on its own project
// only, as its owner and no wider. The host refuses anything else by name before any request is
// made, mints a read-only token for the owner on the run's first read (the owner's own grant cut to
// SCRIPT_READ_MENU, fenced to the run's project, expiring with the run), and asks core's own REST
// app in-process with it, so the authorization a person's own GET meets is the one a script meets.
// The token stays here: the script is handed the JSON body and nothing else. Every read, refused or
// answered, is kept for the run's record.

import { randomBytes } from 'node:crypto';
import {
  SCRIPT_READ_BODY_CAP_BYTES,
  SCRIPT_READ_CAP,
  SCRIPT_READ_REFUSED,
  type ScriptRead,
} from '@forge/contracts/script-sandbox';
import { scriptReadTokenName } from '../credentials/pat-format.js';
import type { PatPermission } from '../credentials/pat-permissions.js';
import { mintTurnCredential, turnAuthorityRefusalOf } from '../credentials/turn-credential.js';
import { resolveTurnAuthority } from '../permissions/index.js';
import { sandboxPorts } from './ports.js';
import type { ReadOutcome, ScriptReader } from './run.js';

/** What a script's token may reach: reads of projects (requirements, workflows, …) and of issues. */
export const SCRIPT_READ_MENU: readonly PatPermission[] = ['projects:read', 'issues:read'];

/** Who a run reads as: its owner, bounded by the token they reached Forge with where they had one. */
export interface ScriptOwner {
  userId: string;
  viaTokenId: string | null;
}

export interface ForgeReader {
  read: ScriptReader;
  /** Every read the run made, in order, with the status it answered or the code it was refused under. */
  reads(): ScriptRead[];
  /** Revokes the run's token, where one was minted; called when the run ends, whatever its end. */
  close(): Promise<void>;
}

const INTERNAL_ORIGIN = 'http://forge.internal';
// path characters a read may name; no percent-encoding, so no encoded dot or slash reaches routing
const PATH_SHAPE = /^\/api(\/[A-Za-z0-9._~-]+)+\/?$/;
const QUERY_SHAPE = /^[A-Za-z0-9._~\-=&,:%+]*$/;

/**
 * Why a read is refused before any request, or null where it is a GET on the run's own project:
 * `/api/projects/<project>[/...]` (its issues, requirements, workflows, …), or
 * `/api/issues/<issue>[/...]`, whose project the token's fence holds to the run's.
 */
export function readRefusal(method: string, path: string, projectId: string): string | null {
  if (method.toUpperCase() !== 'GET') {
    return `${SCRIPT_READ_REFUSED}: ${method} ${path} is refused: a script reads Forge by GET only and never writes; use ctx.forge.get(path)`;
  }
  const [pathname = '', query = '', ...rest] = path.split('?');
  const shaped =
    rest.length === 0 &&
    PATH_SHAPE.test(pathname) &&
    QUERY_SHAPE.test(query) &&
    !pathname.split('/').some((seg) => seg === '.' || seg === '..');
  const own = `/api/projects/${projectId}`;
  const ownProject = pathname === own || pathname.startsWith(`${own}/`);
  const oneIssue = pathname.startsWith('/api/issues/') && pathname.length > '/api/issues/'.length;
  if (shaped && (ownProject || oneIssue)) return null;
  return `${SCRIPT_READ_REFUSED}: GET ${path} is refused: a script reads only its own project, ${own}/... or /api/issues/<issue of it>, named as a plain path (no host, no percent-encoding, no dot segment)`;
}

function bodyMessage(body: unknown): string {
  const e = (body as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  if (e && typeof e.message === 'string') {
    return typeof e.code === 'string' ? `${e.code}: ${e.message}` : e.message;
  }
  return '';
}

/** Opens the reader one run uses; nothing is minted until the script's first read that passes the guard. */
export function openForgeReader(args: {
  projectId: string;
  owner: ScriptOwner | null;
  /** How long the run may last; the token expires a little after it whatever happens. */
  ttlMs: number;
}): ForgeReader {
  const log: ScriptRead[] = [];
  let minted: Promise<
    | { ok: true; token: string; revoke: () => Promise<void> }
    | { ok: false; code: string; message: string }
  > | null = null;
  let closed = false;

  const credential = () => {
    minted ??= (async () => {
      const owner = args.owner;
      if (!owner) {
        return {
          ok: false as const,
          code: SCRIPT_READ_REFUSED,
          message: `${SCRIPT_READ_REFUSED}: this run has no owner to read Forge as: the account that saved the schedule is gone, so an admin saves it again`,
        };
      }
      const resolved = await resolveTurnAuthority({
        userId: owner.userId,
        projectId: args.projectId,
        viaTokenId: owner.viaTokenId,
      });
      if (!resolved.ok) return { ok: false as const, ...resolved.refusal };
      try {
        const turn = await mintTurnCredential({
          authority: resolved.authority,
          menu: SCRIPT_READ_MENU,
          name: scriptReadTokenName(new Date(), randomBytes(4).toString('hex')),
          ttlMs: args.ttlMs,
        });
        return { ok: true as const, token: turn.token, revoke: turn.revoke };
      } catch (err) {
        const refusal = turnAuthorityRefusalOf(err);
        if (refusal) return { ok: false as const, ...refusal };
        throw err;
      }
    })();
    return minted;
  };

  const refused = (method: string, path: string, code: string, message: string): ReadOutcome => {
    log.push({ method, path: path.slice(0, 2048), status: null, refused: code });
    return { ok: false, name: 'ForgeReadRefused', code, message };
  };

  const read: ScriptReader = async (method, path) => {
    const m = method.slice(0, 16) || 'GET';
    if (closed)
      return refused(m, path, SCRIPT_READ_REFUSED, `${SCRIPT_READ_REFUSED}: the run has ended`);
    if (log.length >= SCRIPT_READ_CAP) {
      return refused(
        m,
        path,
        SCRIPT_READ_REFUSED,
        `${SCRIPT_READ_REFUSED}: this run has made ${SCRIPT_READ_CAP} reads, its cap; answer from what they returned`,
      );
    }
    const why = readRefusal(m, path, args.projectId);
    if (why) return refused(m, path, SCRIPT_READ_REFUSED, why);
    const cred = await credential();
    if (!cred.ok) return refused(m, path, cred.code, cred.message);
    const response = await sandboxPorts().restFetch(
      new Request(`${INTERNAL_ORIGIN}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${cred.token}`, accept: 'application/json' },
      }),
    );
    log.push({ method: 'GET', path, status: response.status });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > SCRIPT_READ_BODY_CAP_BYTES) {
      return {
        ok: false,
        name: 'ForgeReadFailed',
        status: response.status,
        message: `GET ${path} answered ${Buffer.byteLength(text, 'utf8')} bytes, past the ${SCRIPT_READ_BODY_CAP_BYTES}-byte cap a script is handed; read a narrower path or a page of it`,
      };
    }
    let body: unknown;
    try {
      body = text === '' ? null : (JSON.parse(text) as unknown);
    } catch {
      return {
        ok: false,
        name: 'ForgeReadFailed',
        status: response.status,
        message: `GET ${path} answered ${response.status} with a body that is not JSON`,
      };
    }
    if (!response.ok) {
      const said = bodyMessage(body);
      return {
        ok: false,
        name: 'ForgeReadFailed',
        status: response.status,
        message: `GET ${path} answered ${response.status}${said ? `: ${said}` : ''}`,
      };
    }
    return { ok: true, body };
  };

  return {
    read,
    reads: () => log.map((r) => ({ ...r })),
    close: async () => {
      closed = true;
      const cred = minted ? await minted.catch(() => null) : null;
      if (cred?.ok) await cred.revoke();
    },
  };
}
