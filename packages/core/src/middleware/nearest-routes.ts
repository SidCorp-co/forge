import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONTRACTS_DIR } from '../api-contract/routes.js';

type Served = { method: string; path: string; segments: string[] };

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const NEAREST_MAX = 6;

let routes: Served[] | null = null;

/** Every `/api` route the checked-in API contract lists: the one description of what is served. */
function served(): Served[] {
  if (routes) return routes;
  const doc = JSON.parse(
    readFileSync(resolve(CONTRACTS_DIR, 'forge-api.openapi.json'), 'utf8'),
  ) as {
    paths: Record<string, Record<string, unknown>>;
  };
  routes = Object.entries(doc.paths)
    .filter(([path]) => path.startsWith('/api/'))
    .flatMap(([path, ops]) =>
      METHODS.filter((m) => m in ops).map((m) => ({
        method: m.toUpperCase(),
        path,
        segments: path.split('/').filter(Boolean),
      })),
    );
  return routes;
}

const isParam = (segment: string) => segment.startsWith('{');

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (next[j - 1] ?? 0) + 1,
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

/**
 * How near a served route is to a path nothing serves: the segments they share at the front (a
 * parameter matches any segment), then the distance between their literal words.
 */
function nearness(route: Served, asked: string[]): { shared: number; distance: number } {
  let shared = 0;
  let distance = 0;
  const length = Math.max(route.segments.length, asked.length);
  for (let i = 0; i < length; i++) {
    const have = route.segments[i];
    const want = asked[i];
    if (have === undefined || want === undefined) {
      distance += 3;
    } else if (isParam(have)) {
      if (distance === 0) shared++;
    } else if (have === want) {
      if (distance === 0) shared++;
    } else {
      distance += editDistance(have, want);
    }
  }
  return { shared, distance };
}

/**
 * The served routes nearest a method and path nothing serves, as `METHOD /path` lines: those that
 * share its resource (the segment after `/api`), nearest word first. Null where the path is outside `/api` or shares no resource with any route.
 */
export function nearestRoutes(path: string): string[] | null {
  const asked = path.split('/').filter(Boolean);
  if (asked[0] !== 'api') return null;
  const resource = asked.slice(0, 2);
  const pool = served().filter((r) => resource.every((s, i) => r.segments[i] === s));
  const ranked = pool
    .map((route) => ({ route, ...nearness(route, asked) }))
    .sort(
      (a, b) =>
        a.distance - b.distance || b.shared - a.shared || a.route.path.localeCompare(b.route.path),
    )
    .slice(0, NEAREST_MAX);
  return ranked.length === 0 ? null : ranked.map((r) => `${r.route.method} ${r.route.path}`);
}
