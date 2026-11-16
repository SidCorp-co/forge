// The doors agents are given, built once from the two sources that already list them (ISS-1251):
// every MCP action the registry serves (`action-catalog.ts`, the catalog `forge_find` searches, which
// holds a room agent's acts as `support.*`), and every REST write the published API contract lists
// (`contracts/forge-api.openapi.json`). A REST read is not a door here: no log records one.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTRACTS_DIR } from '../api-contract/routes.js';
import type { CatalogDoor, DoorCatalog } from '../lib/door-catalog.js';
import { actionCatalog, doorOf } from './action-catalog.js';
import { mcpTools } from './server.js';

const WRITES = ['post', 'put', 'patch', 'delete'] as const;

type OpenApi = { paths: Record<string, Record<string, unknown>> };

/** `/api/projects/{id}/feedback` as the routes are written: `/api/projects/:id/feedback`. */
const templateOf = (path: string) => path.replace(/\{([^}]+)\}/g, ':$1');

/** The resource a route acts on: its path up to the third segment after `/api`, params kept. */
const resourceOf = (template: string) => template.split('/').slice(0, 5).join('/');

/** A route's template as a matcher of a logged path; the more literal segments, the earlier it is tried. */
function matcherOf(template: string): { re: RegExp; literals: number } {
  const parts = template.split('/');
  const re = parts
    .map((p) => (p.startsWith(':') ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { re: new RegExp(`^${re}/?$`), literals: parts.filter((p) => !p.startsWith(':')).length };
}

/** The REST writes the published contract lists, each as a door. */
export function restDoors(document: OpenApi): CatalogDoor[] {
  return Object.entries(document.paths).flatMap(([path, ops]) =>
    WRITES.filter((m) => m in ops).map((m) => {
      const template = templateOf(path);
      return {
        id: `${m.toUpperCase()} ${template}`,
        surface: 'rest' as const,
        summary: null,
        feature: resourceOf(template),
      };
    }),
  );
}

/** Every MCP action the registry serves, each as a door owned by its tool and that tool's REST twin. */
export function mcpDoors(): CatalogDoor[] {
  // the tools are built only to read what they serve, as the contract generator builds them: no
  // handler runs, so the context names no caller
  const tools = mcpTools({ principal: { userId: 'door-catalog' } } as never);
  const twin = new Map(tools.map((t) => [t.name, t.route ? [t.route].flat().join(', ') : null]));
  return [...actionCatalog(tools).values()].map((e) => ({
    id: e.id,
    surface: 'mcp' as const,
    summary: e.summary,
    feature: twin.get(e.tool) ? `${e.tool} (${twin.get(e.tool)})` : e.tool,
  }));
}

/** The catalog over `doors`, answering which door a logged call is. */
export function catalogOf(doors: readonly CatalogDoor[]): DoorCatalog {
  const byId = new Map(doors.map((d) => [d.id, d]));
  const routes = doors
    .filter((d) => d.surface === 'rest')
    .map((d) => {
      const [method, template] = d.id.split(' ') as [string, string];
      return { door: d, method, ...matcherOf(template) };
    })
    .sort((a, b) => b.literals - a.literals);
  return {
    doors,
    doorOf({ tool, action }) {
      if (!action) return null;
      if (tool !== 'rest') return byId.get(`${doorOf(tool)}.${action}`) ?? null;
      const [method, path] = action.split(' ');
      if (!method || !path) return null;
      return routes.find((r) => r.method === method && r.re.test(path))?.door ?? null;
    },
  };
}

let built: DoorCatalog | null = null;

/** The catalog this build serves, read once: both sources are fixed for the life of the process. */
export function servedDoorCatalog(): DoorCatalog {
  if (built) return built;
  const document = JSON.parse(
    readFileSync(resolve(CONTRACTS_DIR, 'forge-api.openapi.json'), 'utf8'),
  ) as OpenApi;
  built = catalogOf([...mcpDoors(), ...restDoors(document)]);
  return built;
}
