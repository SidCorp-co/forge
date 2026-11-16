// The module map's nodes (ISS-1256): the project's module labels with their paths and roots, and the
// one resolver of a relation's end or a placed record by its `{ type, ref }`. A capability's module is
// the module label named after the code module its door lives in (the door catalog's `paths`, the
// same naming the Modules screen traces code by); nothing else here derives a module.

import type { CapabilityCard } from '@forge/contracts/capability-cards';
import {
  CODE_ANCHOR_PATTERN,
  CODE_ANCHOR_SHAPE,
  type ModuleMapNodeType,
  type ModuleMapRefusalCode,
  REQUIREMENT_REF_PATTERN,
} from '@forge/contracts/module-map';
import { modulePaths } from '@forge/contracts/modules';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { entryForMap } from '../knowledge/index.js';
import { type CatalogDoor, doorCatalog } from '../lib/door-catalog.js';
import { refuser } from '../lib/refusal.js';
import { readNodes } from './module-standing-read.js';

const refuse = refuser<ModuleMapRefusalCode>('MODULE_MAP_REFUSED');

export interface MapModule {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  description: string | null;
  /** Its slug path from the root: `execution/devices`. */
  path: string;
  /** Its root module, the business module (pillar) it rolls up to. */
  rootId: string;
}

export interface MapModules {
  list: MapModule[];
  byId: Map<string, MapModule>;
  bySlug: Map<string, MapModule>;
}

/** The project's module labels, each with its path and root. */
export async function mapModules(projectId: string): Promise<MapModules> {
  const nodes = await readNodes(projectId);
  const paths = modulePaths(nodes);
  const byIdRaw = new Map(nodes.map((n) => [n.id, n]));
  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let at = byIdRaw.get(id);
    while (at?.parentId && byIdRaw.has(at.parentId) && !seen.has(at.id)) {
      seen.add(at.id);
      at = byIdRaw.get(at.parentId);
    }
    return at?.id ?? id;
  };
  const list = nodes.map(
    (n): MapModule => ({
      id: n.id,
      slug: n.slug,
      name: n.name,
      parentId: n.parentId,
      description: n.description,
      path: paths.get(n.id) ?? n.slug,
      rootId: rootOf(n.id),
    }),
  );
  return {
    list,
    byId: new Map(list.map((m) => [m.id, m])),
    bySlug: new Map(list.map((m) => [m.slug, m])),
  };
}

/** The module a slug (or its path) names; refused `MODULE_MAP_MODULE_UNKNOWN` naming what is valid. */
export function moduleNamed(modules: MapModules, ref: string, path = '/module'): MapModule {
  const found = modules.bySlug.get(ref) ?? modules.list.find((m) => m.path === ref || m.id === ref);
  if (found) return found;
  const roots = modules.list
    .filter((m) => m.parentId === null)
    .map((m) => m.slug)
    .join(', ');
  throw refuse(
    'MODULE_MAP_MODULE_UNKNOWN',
    `no module of this project is "${ref}": name a module label by its slug or path (roots: ${roots || 'none yet'}); a project admin creates a missing one with POST /api/projects/:id/labels (kind module)`,
    path,
  );
}

/** The module a slug names in the project, read fresh. */
export async function moduleBySlug(projectId: string, slug: string): Promise<MapModule> {
  return moduleNamed(await mapModules(projectId), slug);
}

/** The code module a door lives in: its first path under `packages/core/src/`, as modules.json names it. */
export const codeModuleOf = (paths: readonly string[] | undefined): string | null => {
  const path = paths?.find((p) => p.startsWith('packages/core/src/'));
  return path ? path.slice('packages/core/src/'.length).replace(/\/+$/, '') || null : null;
};

/**
 * Each served card, with the module label named after the code module its door lives in (the
 * catalog's `paths`, the same naming the Modules screen traces code by), or null where no label is.
 */
export function capabilityModules(
  modules: MapModules,
  doors: readonly CatalogDoor[] = doorCatalog().doors,
): { card: CapabilityCard; module: MapModule | null }[] {
  const byName = new Map(modules.list.map((m) => [m.name, m]));
  return doors.flatMap((d) => {
    if (!d.card) return [];
    const code = codeModuleOf(d.paths);
    return [{ card: d.card, module: code ? (byName.get(code) ?? null) : null }];
  });
}

/** Every card the door catalog serves. */
export function servedCards(): CapabilityCard[] {
  return doorCatalog().doors.flatMap((d) => (d.card ? [d.card] : []));
}

/** An end as resolved: its type and ref as stored, and its title. */
export interface ResolvedEnd {
  type: ModuleMapNodeType;
  ref: string;
  title: string | null;
  /** The knowledge entry's id, for a term or a rule. */
  entryId?: string;
}

const notFound = (type: string, ref: string, path: string, valid: string) =>
  refuse('MODULE_MAP_NODE_NOT_FOUND', `no ${type} of this project is "${ref}": ${valid}`, path);

/** A requirement ref as stored: `REQ-12` or `REQ-12 BC-3`, with its seq and code. */
export function requirementRef(ref: string): { seq: number; code: string | null } | null {
  const norm = ref.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!REQUIREMENT_REF_PATTERN.test(norm)) return null;
  const [req, bc] = norm.split(' ');
  return { seq: Number((req as string).slice(4)), code: bc ?? null };
}

/**
 * Resolve one end of a relation, or refuse it by name: a term or a rule by its entry slug (of that
 * kind), a capability by its card id, a requirement or a behaviour as `REQ-<n>[ BC-<m>]`, a
 * decision by its comment id, a module by its slug, code by its anchor.
 */
export async function resolveEnd(
  projectId: string,
  type: ModuleMapNodeType,
  ref: string,
  path: string,
): Promise<ResolvedEnd> {
  switch (type) {
    case 'term':
    case 'rule': {
      const entry = await entryForMap(projectId, ref);
      if (!entry) throw notFound(type, ref, path, 'name a live knowledge entry by its slug');
      const want = type === 'term' ? 'glossary' : 'rule';
      if (entry.kind !== want) {
        throw refuse(
          'MODULE_MAP_KIND_MISMATCH',
          `"${ref}" is a knowledge entry of kind ${entry.kind}; a ${type} is an entry of kind ${want}`,
          path,
        );
      }
      return { type, ref, title: entry.title, entryId: entry.id };
    }
    case 'capability': {
      const card = servedCards().find((c) => c.id === ref);
      if (!card) {
        throw notFound(type, ref, path, 'name a capability card by its door, e.g. `module.get`');
      }
      return { type, ref, title: card.purpose };
    }
    case 'requirement': {
      const parsed = requirementRef(ref);
      if (!parsed) throw notFound(type, ref, path, 'name it `REQ-<n>` or `REQ-<n> BC-<m>`');
      const [row] = rowsOf<{ title: string; has_code: boolean }>(
        await db.execute(sql`
          SELECT r.title, (${parsed.code}::text IS NULL OR EXISTS (
              SELECT 1 FROM requirement_criteria c
               WHERE c.requirement_id = r.id AND c.code = ${parsed.code} AND c.retired_revision IS NULL
            )) AS has_code
            FROM requirements r WHERE r.project_id = ${projectId} AND r.req_seq = ${parsed.seq}`),
      );
      if (!row?.has_code) throw notFound(type, ref, path, 'name a live requirement or behaviour');
      const stored = parsed.code ? `REQ-${parsed.seq} ${parsed.code}` : `REQ-${parsed.seq}`;
      return { type, ref: stored, title: row.title };
    }
    case 'decision': {
      const decision = await decisionIn(projectId, ref);
      if (!decision) throw notFound(type, ref, path, 'name a decision comment by its id');
      return { type, ref, title: decision.title };
    }
    case 'module': {
      const m = moduleNamed(await mapModules(projectId), ref, path);
      return { type, ref: m.slug, title: m.name };
    }
    case 'code': {
      const anchor = ref.trim().replace(/^\.\//, '');
      if (!CODE_ANCHOR_PATTERN.test(anchor)) {
        throw refuse(
          'MODULE_MAP_ANCHOR_SHAPE',
          `"${ref}" is not a code anchor. Valid: ${CODE_ANCHOR_SHAPE}.`,
          path,
        );
      }
      return { type, ref: anchor, title: null };
    }
    case 'reference': {
      const [row] = rowsOf<{ title: string }>(
        await db.execute(sql`
          SELECT title FROM reference_sources
           WHERE id::text = ${ref} AND project_id = ${projectId} AND removed_at IS NULL`),
      );
      if (!row) throw notFound(type, ref, path, "name one of the project's own sources by its id");
      return { type, ref, title: row.title };
    }
  }
}

/** A decision comment of the project, by id, with a one-line title; null where none is. */
export async function decisionIn(
  projectId: string,
  id: string,
): Promise<{ id: string; title: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = rowsOf<{ id: string; title: string }>(
    await db.execute(sql`
      SELECT c.id, left(coalesce(c.decision->>'decision', c.body), 200) AS title
        FROM comments c
        LEFT JOIN issues i ON i.id = c.issue_id
        LEFT JOIN requirements r ON r.id = c.requirement_id
        LEFT JOIN project_workflows w ON w.id = c.workflow_id
        LEFT JOIN feedback f ON f.id = c.feedback_id
       WHERE c.id = ${id}::uuid AND c.intent = 'decision'
         AND coalesce(i.project_id, r.project_id, w.project_id, f.project_id) = ${projectId}::uuid`),
  );
  return row ?? null;
}

/**
 * The capability cards a module holds, over its subtree: the map's Capabilities branch, which the
 * capabilities read narrows to (`metrics/capabilities.ts`). The module is refused by name if unknown.
 */
export async function capabilitiesIn(
  projectId: string,
  ref: string,
): Promise<{ module: string; cards: string[] }> {
  const modules = await mapModules(projectId);
  const module = moduleNamed(modules, ref, '/module');
  const cards = capabilityModules(modules)
    .filter(
      ({ module: m }) => m && (m.path === module.path || m.path.startsWith(`${module.path}/`)),
    )
    .map(({ card }) => card.id);
  return { module: module.path, cards };
}
