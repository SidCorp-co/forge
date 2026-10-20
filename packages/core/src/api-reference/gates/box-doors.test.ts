import { beforeAll, describe, expect, it } from 'vitest';
import { type RouteEntry, type RouteSource, readRoutes } from '../document/registry.js';

/**
 * ISS-1421 r16 — judge-69 sent a paired box's token to three session routes that act for a person
 * and was told "Not a project member.", "Requires project member access." and "Owner or admin role
 * required.": each loaded a person's project access for a principal that names no person. Every
 * route a box's token gets through to says, in its handler, what it does with a box: refuses it in
 * the true sentence (`personOrRefuse`, or a session guard that calls it), or serves the box's own
 * session by name. A handler that does neither reads a box as a person who belongs to nothing.
 */
const HANDLES_THE_BOX =
  /personOrRefuse|ensureSession(?:Member|Role|OwnerOrAdmin)|principal|assertDeviceOwnsSession|assertOwnsSession|boxSessionFilter|authorizeSession/;

/** Routes whose handler reads no person and no project, each with why that is safe for a box. */
const SERVES_ANY_PRINCIPAL: Readonly<Record<string, string>> = {
  'POST /api/agent-sessions/prompt-built':
    "relays a box's built prompt to the web client waiting on its request id, reading no project",
};

let routes: RouteEntry[];

beforeAll(async () => {
  const { app } = (await import('../../index.js')) as unknown as { app: RouteSource };
  routes = readRoutes(app);
}, 120_000);

describe("a route a paired box's token gets through to", () => {
  it('says in its handler what it does with a box', () => {
    const silent = routes
      .filter((r) => r.admitsBox && !(r.key in SERVES_ANY_PRINCIPAL))
      .filter((r) => !HANDLES_THE_BOX.test(String(r.handler)))
      .map((r) => r.key);
    expect(silent, 'each route reads a box as a person who belongs to nothing').toEqual([]);
  });

  it('is found: the walk reads the session routes behind the user-or-device gate', () => {
    const boxed = routes.filter((r) => r.admitsBox).map((r) => r.key);
    expect(boxed.length).toBeGreaterThan(30);
    for (const key of [
      'GET /api/agent-sessions/queue-stats',
      'POST /api/agent-sessions',
      'POST /api/agent-sessions/sweep-zombies',
      'POST /api/agent-sessions/start',
    ]) {
      expect(boxed).toContain(key);
    }
  });

  it('names no exception the app no longer serves', () => {
    const served = new Set(routes.map((r) => r.key));
    expect(Object.keys(SERVES_ANY_PRINCIPAL).filter((k) => !served.has(k))).toEqual([]);
  });
});
