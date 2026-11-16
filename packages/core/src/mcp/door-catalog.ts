// The doors agents are given, built once from the two sources that already list them (ISS-1251):
// every MCP action the registry serves (`action-catalog.ts`, the catalog `forge_find` searches, which
// holds a room agent's acts as `support.*`), and every REST write the published API contract lists
// (`contracts/forge-api.openapi.json`). A REST read is not a door here: no log records one.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CapabilityCard } from '@forge/contracts/capability-cards';
import { CONTRACTS_DIR } from '../api-contract/routes.js';
import type { CatalogDoor, DoorCatalog } from '../lib/door-catalog.js';
import declaration from '../modules.json' with { type: 'json' };
import { AFFORDANCE_CARDS } from '../prompt/index.js';
import { actionCatalog, doorOf } from './action-catalog.js';
import { REST_CARDS } from './rest-cards.js';
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
  const sources = new Map(tools.map((t) => [t.name, t.source ? [dirname(t.source)] : []]));
  return [...actionCatalog(tools).values()].map((e) => ({
    id: e.id,
    surface: 'mcp' as const,
    summary: e.summary,
    feature: twin.get(e.tool) ? `${e.tool} (${twin.get(e.tool)})` : e.tool,
    ...(e.card ? { card: e.card } : {}),
    paths: sources.get(e.tool) ?? [],
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

/** A REST card's door lives in the module that owns it, which `modules.json` must declare. */
function moduleDirOf(card: CapabilityCard): string {
  if (!Object.hasOwn(declaration.modules, card.owner)) {
    throw new Error(
      `door catalog: the card for ${card.id} is owned by ${card.owner}, which modules.json declares no module (mcp/door-catalog.ts)`,
    );
  }
  return `packages/core/src/${card.owner}`;
}

/** The doors with the REST cards written for them; a card for a door no source lists is refused by name. */
export function carded(doors: CatalogDoor[], cards: readonly CapabilityCard[]): CatalogDoor[] {
  const byId = new Map(cards.map((c) => [c.id, c]));
  const out = doors.map((d) => {
    const card = byId.get(d.id);
    byId.delete(d.id);
    return card ? { ...d, card, paths: [moduleDirOf(card)] } : d;
  });
  if (byId.size > 0) {
    throw new Error(
      `door catalog: a capability card names ${[...byId.keys()].join(', ')}, which no MCP action or REST write of this build is (mcp/door-catalog.ts)`,
    );
  }
  return out;
}

let built: DoorCatalog | null = null;

/** The catalog this build serves, read once: both sources are fixed for the life of the process. */
export function servedDoorCatalog(): DoorCatalog {
  if (built) return built;
  const document = JSON.parse(
    readFileSync(resolve(CONTRACTS_DIR, 'forge-api.openapi.json'), 'utf8'),
  ) as OpenApi;
  built = catalogOf(
    carded([...mcpDoors(), ...restDoors(document)], [...AFFORDANCE_CARDS, ...REST_CARDS]),
  );
  return built;
}
