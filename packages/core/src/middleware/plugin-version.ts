/**
 * The forge-plugin's version handshake. Core and the plugin ship on two clocks, so a plugin client
 * names its version in `x-forge-plugin` and core reads it at the auth gate: a malformed value is
 * refused by name, a well-formed one is recorded on the row the request authenticated as, and a
 * route that has narrowed a shape older plugins still send asks {@link narrowedFor} whether this
 * caller is refused or let through with a warning.
 */

import {
  comparePluginVersions,
  FORGE_WARNING_HEADER,
  PLUGIN_VERSION_HEADER,
  PLUGIN_VERSION_MAX_LENGTH,
  PLUGIN_VERSION_SHAPE,
  type PluginVersion,
  parsePluginVersion,
} from '@forge/contracts/plugin-version';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { recordTokenPluginVersion } from '../credentials/pat-plugin-version.js';
import { recordDevicePluginVersion } from '../devices/plugin-version-record.js';
import { background } from '../lib/background.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';

/**
 * The row a request on a header token authenticated as: the paired box a box token belongs to, else
 * the personal access token itself. A person's browser session or session JWT is none.
 */
export type PluginCaller = { kind: 'device'; id: string } | { kind: 'token'; id: string };

interface PluginClient {
  caller: PluginCaller;
  /** The version the request named; null where it named none. */
  version: PluginVersion | null;
}

const PLUGIN_CLIENT_VAR = 'pluginClient';

/** A version heard again within this long is not written again; a changed version always is. */
export const PLUGIN_VERSION_RECORD_INTERVAL_MS = 10 * 60 * 1000;

const lastRecorded = new Map<string, { version: string; at: number }>();
const warned = new Set<string>();
const writes = background();

const callerKey = (caller: PluginCaller) => `${caller.kind}:${caller.id}`;

function malformed(raw: string): HTTPException {
  const shown =
    raw.length > PLUGIN_VERSION_MAX_LENGTH ? `${raw.slice(0, PLUGIN_VERSION_MAX_LENGTH)}…` : raw;
  return new HTTPException(400, {
    message: `the ${PLUGIN_VERSION_HEADER} header names ${JSON.stringify(shown)}, which is not a plugin version; send ${PLUGIN_VERSION_SHAPE}, or leave the header out`,
    cause: { code: 'PLUGIN_VERSION_MALFORMED' },
  });
}

function recordPluginVersion(caller: PluginCaller, version: string): void {
  const key = callerKey(caller);
  const now = Date.now();
  const held = lastRecorded.get(key);
  if (held && held.version === version && now - held.at < PLUGIN_VERSION_RECORD_INTERVAL_MS) return;
  lastRecorded.set(key, { version, at: now });
  writes.start(
    () =>
      caller.kind === 'device'
        ? recordDevicePluginVersion(caller.id, version)
        : recordTokenPluginVersion(caller.id, version),
    (err) => {
      lastRecorded.delete(key);
      logger.warn({ err, caller }, 'plugin-version: the version heard was not written');
    },
  );
}

/**
 * Read at every auth gate once it has resolved who is calling. A request that names a version
 * names one in {@link PLUGIN_VERSION_SHAPE} or is refused `PLUGIN_VERSION_MALFORMED`, whatever
 * credential carried it. A request on a header token (`caller` set) is a plugin client: its version
 * is recorded on that row and is what {@link narrowedFor} decides on. The first gate to admit a
 * request decides; a later router's gate re-reads nothing.
 */
export function admitPluginVersion(c: Context, caller: PluginCaller | null): void {
  const raw = c.req.header(PLUGIN_VERSION_HEADER);
  const version = raw === undefined ? null : parsePluginVersion(raw);
  if (raw !== undefined && version === null) throw malformed(raw);
  if (!caller || c.get(PLUGIN_CLIENT_VAR)) return;
  c.set(PLUGIN_CLIENT_VAR, { caller, version } satisfies PluginClient);
  if (raw !== undefined) recordPluginVersion(caller, raw);
}

/** Every version write this process has started, settled; for a test or a shutdown. */
export function pluginVersionWritesSettled(): Promise<void> {
  return writes.settled();
}

export interface Narrowing {
  /** The first plugin version that no longer sends the narrowed shape, e.g. `3.36.681`. */
  since: string;
  /** The refusal code the route answers a caller that is held to the narrowing. */
  code: string;
  /** The refusal's sentence: what was wrong and what shape is valid. */
  detail: string;
  /** Where in the request the narrowed shape sits, as a JSON pointer; the whole request by default. */
  path?: string;
}

/**
 * Called by a route where it meets a shape it has narrowed away but older plugins still send.
 *
 * - A plugin client naming a version at or above `since` is refused: it throws the route's refusal,
 *   `code` with `detail`, exactly as the route refused before this helper.
 * - A plugin client naming an older version, or naming none, is let through: this returns, the
 *   route goes on with the old shape, and the response carries `x-forge-warning: <code>: <detail>`
 *   (appended, one per narrowing met). Core logs it once per calling box or token per code.
 * - A caller that is not a plugin client (a person's browser session or session JWT) is refused as
 *   today.
 *
 * A plugin client naming no version is let through because the plugin releases that never send
 * the header are exactly the old ones; once the plugin sends it, a narrowing can be held to callers
 * that name a version by raising `since` past every plugin still in the field.
 */
export function narrowedFor(c: Context, narrowing: Narrowing): void {
  const since = parsePluginVersion(narrowing.since);
  if (!since) {
    throw new Error(
      `narrowedFor: since ${JSON.stringify(narrowing.since)} is not ${PLUGIN_VERSION_SHAPE}`,
    );
  }
  const client = c.get(PLUGIN_CLIENT_VAR) as PluginClient | undefined;
  const held =
    !client || (client.version !== null && comparePluginVersions(client.version, since) >= 0);
  if (held) {
    throw new RefusalError(
      [{ code: narrowing.code, path: narrowing.path ?? '', detail: narrowing.detail }],
      narrowing.code,
    );
  }
  c.header(FORGE_WARNING_HEADER, headerSafe(`${narrowing.code}: ${narrowing.detail}`), {
    append: true,
  });
  const once = `${callerKey(client.caller)}:${narrowing.code}`;
  if (warned.has(once)) return;
  warned.add(once);
  logger.warn(
    {
      caller: client.caller,
      code: narrowing.code,
      since: narrowing.since,
      route: `${c.req.method} ${c.req.path}`,
    },
    `plugin-version: a narrowed shape let through for a plugin older than ${narrowing.since}`,
  );
}

/** A header value carries printable ASCII only. */
function headerSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]+/g, ' ').trim();
}
