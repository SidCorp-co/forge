import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  bindingMem,
  COOLIFY_CONNECTION,
  ORG,
  resetBindingMem,
  SHOPIFY_CONNECTION,
} from './binding-store.fixture.js';
import { ADMIN, mem, PROJECT, VIEWER } from './memory-store.fixture.js';

const { projectConfigRoutes } = await import('./routes.js');

export const BINDING = '8b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e';
export const SOURCE = '7a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

function app() {
  const a = new Hono();
  a.route('/api/projects', projectConfigRoutes);
  a.onError((err, c) => {
    if (err instanceof HTTPException) {
      const cause = err.cause as { code?: string } | undefined;
      return c.json({ code: cause?.code ?? 'HTTP', message: err.message }, err.status);
    }
    throw err;
  });
  return a;
}

export const call = (method: string, path: string, body?: unknown, who = ADMIN) =>
  app().request(`/api/projects/${PROJECT}${path}`, {
    method,
    headers: { authorization: `Bearer user:${who}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

export const coolifyDoc = (overrides: Record<string, unknown> = {}) => ({
  $schema: 'https://forge.sidcorp.co/schemas/binding-v1.json',
  version: 1,
  id: BINDING,
  role: 'deploy',
  connection: COOLIFY_CONNECTION,
  target: {
    provider: 'coolify',
    applications: [{ label: 'primary', resourceUuid: 'y8w4c4kss8ogo8gc44ow44kc' }],
  },
  ...overrides,
});

type Refused = {
  error: { code: string; refusals: { code: string; path: string; detail: string }[] };
};
export const refusalsOf = async (res: Response) => ((await res.json()) as Refused).error.refusals;

/** An admin and a viewer of PROJECT, an org Coolify connection and the admin's own Shopify one. */
export function resetBindingWorld(): void {
  mem.project.clear();
  mem.profiles.clear();
  mem.roles.clear();
  mem.roles.set(ADMIN, 'admin');
  mem.roles.set(VIEWER, 'viewer');
  resetBindingMem();
  bindingMem.connections.set(COOLIFY_CONNECTION, {
    id: COOLIFY_CONNECTION,
    provider: 'coolify',
    ownerType: 'org',
    ownerId: ORG,
    active: true,
  });
  bindingMem.connections.set(SHOPIFY_CONNECTION, {
    id: SHOPIFY_CONNECTION,
    provider: 'shopify',
    ownerType: 'user',
    ownerId: ADMIN,
    active: true,
  });
  bindingMem.orgAdmins.add(ADMIN);
}
