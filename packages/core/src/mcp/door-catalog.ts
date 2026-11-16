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
import { REST_TWINS } from './twins.js';

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
  // a REST door answers for itself, and a REST twin for the action it was folded into
  const routes = doors
    .flatMap((d) =>
      [...(d.surface === 'rest' ? [d.id] : []), ...(d.twins ?? [])].map((id) => {
        const [method, template] = id.split(' ') as [string, string];
        return { door: d, method, ...matcherOf(template) };
      }),
    )
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

/**
 * The doors with each REST twin folded into the MCP action whose act it does (`twins.ts`): one row,
 * one card from whichever side carries it. A pair this build does not serve, or one carrying two
 * cards, is refused by name.
 */
export function twinned(
  doors: readonly CatalogDoor[],
  twins: Readonly<Record<string, readonly string[]>> = REST_TWINS,
): CatalogDoor[] {
  const byId = new Map(doors.map((d) => [d.id, d]));
  const missing: string[] = [];
  const twice: string[] = [];
  const folded = new Map<string, CatalogDoor>();
  const gone = new Set<string>();
  for (const [action, rest] of Object.entries(twins)) {
    const door = byId.get(action);
    const routes = rest.map((r) => byId.get(r));
    if (door?.surface !== 'mcp') missing.push(action);
    rest.forEach((r, i) => {
      if (routes[i]?.surface !== 'rest') missing.push(r);
    });
    if (!door || routes.some((r) => !r)) continue;
    const pair = [door, ...(routes as CatalogDoor[])];
    // the action takes its twin's card where the act's one card sits on the REST side (`cards.ts`)
    const cards = [
      ...new Map(pair.flatMap((d) => (d.card ? [[d.card.id, d.card] as const] : []))).values(),
    ];
    if (cards.length > 1) twice.push(`${action} (${cards.map((c) => c.id).join(', ')})`);
    const paths = [...new Set(pair.flatMap((d) => d.paths ?? []))];
    folded.set(action, { ...door, ...(cards[0] ? { card: cards[0] } : {}), paths, twins: rest });
    for (const r of rest) gone.add(r);
  }
  if (missing.length > 0) {
    throw new Error(
      `door catalog: a REST twin pair names ${missing.join(', ')}, which this build serves no such door as (mcp/twins.ts)`,
    );
  }
  if (twice.length > 0) {
    throw new Error(
      `door catalog: one act carries two cards, ${twice.join('; ')}: keep one (mcp/twins.ts)`,
    );
  }
  return doors.filter((d) => !gone.has(d.id)).map((d) => folded.get(d.id) ?? d);
}

let built: DoorCatalog | null = null;

/** The catalog this build serves, read once: both sources are fixed for the life of the process. */
export function servedDoorCatalog(): DoorCatalog {
  if (built) return built;
  const document = JSON.parse(
    readFileSync(resolve(CONTRACTS_DIR, 'forge-api.openapi.json'), 'utf8'),
  ) as OpenApi;
  built = catalogOf(
    twinned(carded([...mcpDoors(), ...restDoors(document)], [...AFFORDANCE_CARDS, ...REST_CARDS])),
  );
  return built;
}
