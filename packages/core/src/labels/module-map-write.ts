// The module map's two writes (ISS-1256), each one act an agent or a person calls: placing a record
// in a module (the `belongs_to` relation, which is the record's module field) and relating a term or a
// rule to what it is used in, governs, comes from or is anchored at. Each judges its input by name
// and calls the setter of the module that owns the record; none infers a module or a relation.

import {
  MODULE_MAP_NODE_TYPES,
  MODULE_MAP_PLACEABLE_TYPES,
  MODULE_RELATION_ENDS,
  MODULE_RELATION_KINDS,
  type ModuleMapNodeType,
  type ModuleMapPlaceableType,
  type ModuleMapRefusalCode,
  type ModulePlacementResult,
  type ModulePlacementWrite,
  type ModuleRelationKind,
  type ModuleRelationResult,
  type ModuleRelationWrite,
  type ModuleStoredRelationKind,
} from '@forge/contracts/module-map';
import { sql } from 'drizzle-orm';
import { setDecisionModule } from '../comments/index.js';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { setIssuePrimaryModule } from '../issues/index.js';
import {
  entryForMap,
  type MapWriter,
  removeKnowledgeRelation,
  setKnowledgeModule,
  writeKnowledgeRelation,
} from '../knowledge/index.js';
import { setLessonModule } from '../lessons/index.js';
import { refuser } from '../lib/refusal.js';
import {
  decisionIn,
  type MapModules,
  mapModules,
  moduleNamed,
  requirementRef,
  resolveEnd,
} from './module-map-nodes.js';
import { setReferenceModuleOf, setRequirementModuleOf } from './ports.js';

const refuse = refuser<ModuleMapRefusalCode>('MODULE_MAP_REFUSED');

/** A relation kind read by name; anything but the five is refused naming them (no generic "related"). */
export function relationKindOf(raw: string): ModuleRelationKind {
  const kind = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if ((MODULE_RELATION_KINDS as readonly string[]).includes(kind)) {
    return kind as ModuleRelationKind;
  }
  throw refuse(
    'MODULE_MAP_RELATION_KIND_UNKNOWN',
    `"${raw}" is not a relation kind of the module map. Valid: ${MODULE_RELATION_KINDS.join(', ')}; there is no generic "related" kind: name how the two are tied, or place the record in its module.`,
    '/kind',
  );
}

/** A node type read by name, refused naming the valid ones. */
function nodeTypeOf<T extends string>(raw: string, valid: readonly T[], path: string): T {
  const type = raw.trim().toLowerCase();
  if ((valid as readonly string[]).includes(type)) return type as T;
  throw refuse(
    'MODULE_MAP_TYPE_UNKNOWN',
    `"${raw}" is not a type here. Valid: ${valid.join(', ')}`,
    path,
  );
}

/** Whether `kind` joins a `from` end to a `to` end of these types; refused naming what it joins. */
export function assertEnds(kind: ModuleRelationKind, from: string, to: string): void {
  const ends = MODULE_RELATION_ENDS[kind];
  const okFrom = (ends.from as readonly string[]).includes(from);
  const okTo = (ends.to as readonly string[]).includes(to);
  if (okFrom && okTo) return;
  throw refuse(
    'MODULE_MAP_RELATION_ENDS',
    `${kind} joins ${ends.from.join(' or ')} → ${ends.to.join(' or ')}; this write names ${from} → ${to}`,
    okFrom ? '/to/type' : '/from/type',
  );
}

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-([1-9]\d*)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function issueIn(
  projectId: string,
  ref: string,
): Promise<{ id: string; title: string } | null> {
  const seq = ISSUE_KEY.exec(ref.trim())?.[1];
  if (!seq && !UUID.test(ref)) return null;
  const [row] = rowsOf<{ id: string; title: string }>(
    await db.execute(
      seq
        ? sql`SELECT id, title FROM issues WHERE project_id = ${projectId} AND iss_seq = ${Number(seq)} AND archived_at IS NULL`
        : sql`SELECT id, title FROM issues WHERE project_id = ${projectId} AND id = ${ref}::uuid AND archived_at IS NULL`,
    ),
  );
  return row ?? null;
}

const missing = (type: string, ref: string, how: string) =>
  refuse('MODULE_MAP_NODE_NOT_FOUND', `no ${type} of this project is "${ref}": ${how}`, '/ref');

/** Set one record's module through the module that owns it; the module it had before, by id. */
async function setModuleOf(
  projectId: string,
  type: ModuleMapPlaceableType,
  ref: string,
  moduleId: string | null,
): Promise<string | null> {
  switch (type) {
    case 'term':
    case 'rule':
    case 'knowledge': {
      const entry = await entryForMap(projectId, ref);
      if (!entry) throw missing(type, ref, 'name a live knowledge entry by its slug');
      const want = type === 'term' ? 'glossary' : type === 'rule' ? 'rule' : null;
      if (want && entry.kind !== want) {
        throw refuse(
          'MODULE_MAP_KIND_MISMATCH',
          `"${ref}" is a knowledge entry of kind ${entry.kind}; a ${type} is kind ${want} (place it as type knowledge)`,
          '/type',
        );
      }
      return setKnowledgeModule(entry.id, moduleId);
    }
    case 'requirement': {
      const parsed = requirementRef(ref);
      if (!parsed || parsed.code) {
        throw missing(type, ref, 'name the requirement as `REQ-<n>`; its behaviours sit with it');
      }
      const set = await setRequirementModuleOf(projectId, parsed.seq, moduleId);
      if (!set) throw missing(type, ref, 'name a requirement of this project');
      return set.previous;
    }
    case 'decision': {
      if (!(await decisionIn(projectId, ref))) {
        throw missing(type, ref, 'name a decision comment of this project by its id');
      }
      return (await setDecisionModule(ref, moduleId)) ?? null;
    }
    case 'reference': {
      const set = UUID.test(ref) ? await setReferenceModuleOf(projectId, ref, moduleId) : undefined;
      if (!set) throw missing(type, ref, "name one of the project's own sources by its id");
      return set.previous;
    }
    case 'issue': {
      const issue = await issueIn(projectId, ref);
      if (!issue) throw missing(type, ref, 'name an issue by its key (`ISS-12`) or id');
      return setIssuePrimaryModule(issue.id, moduleId);
    }
    case 'lesson': {
      const n = /^L-([1-9]\d*)$/i.exec(ref.trim())?.[1];
      const set = n ? await setLessonModule(projectId, Number(n), moduleId) : undefined;
      if (!set) throw missing(type, ref, 'name a lesson as `L-<n>`');
      return set.previous;
    }
  }
}

const slugOf = (modules: MapModules, id: string | null) =>
  id === null ? null : (modules.byId.get(id)?.slug ?? null);

/** Place a record in a module, or take it out of every module (`module: null`). */
export async function placeRecord(
  projectId: string,
  write: ModulePlacementWrite,
): Promise<ModulePlacementResult> {
  const type = nodeTypeOf(write.type, MODULE_MAP_PLACEABLE_TYPES, '/type');
  const modules = await mapModules(projectId);
  const target = write.module === null ? null : moduleNamed(modules, write.module);
  const previous = await setModuleOf(projectId, type, write.ref.trim(), target?.id ?? null);
  return {
    type,
    ref: write.ref.trim(),
    module: target?.slug ?? null,
    previous: slugOf(modules, previous),
  };
}

/**
 * Write one relation. `belongs_to` is the placement of its `from` end in the module its `to` names;
 * the other four are stored, each from a term or a rule, the same relation written twice standing once.
 */
export async function relate(
  projectId: string,
  write: ModuleRelationWrite,
  writer: MapWriter,
): Promise<ModuleRelationResult | ModulePlacementResult> {
  const kind = relationKindOf(write.kind);
  const fromType = nodeTypeOf(
    write.from.type,
    [...new Set<string>([...MODULE_MAP_PLACEABLE_TYPES, ...MODULE_MAP_NODE_TYPES])],
    '/from/type',
  );
  const toType = nodeTypeOf(write.to.type, MODULE_MAP_NODE_TYPES, '/to/type');
  assertEnds(kind, fromType, toType);
  if (kind === 'belongs_to') {
    return placeRecord(projectId, { type: fromType, ref: write.from.ref, module: write.to.ref });
  }
  const from = await resolveEnd(
    projectId,
    fromType as ModuleMapNodeType,
    write.from.ref,
    '/from/ref',
  );
  const to = await resolveEnd(projectId, toType, write.to.ref, '/to/ref');
  if (!from.entryId) throw new Error('module map: a stored relation starts at no knowledge entry');
  const made = await writeKnowledgeRelation({
    projectId,
    fromEntryId: from.entryId,
    kind: kind as ModuleStoredRelationKind,
    toType: to.type as 'term' | 'rule' | 'capability' | 'requirement' | 'decision' | 'code',
    toRef: to.ref,
    writer,
  });
  return {
    id: made.id,
    kind: kind as ModuleStoredRelationKind,
    from: { type: from.type, ref: from.ref },
    to: { type: to.type, ref: to.ref },
    created: made.created,
  };
}

/** Remove one stored relation; refused by name where the project holds none by that id. */
export async function unrelate(projectId: string, id: string): Promise<{ removed: string }> {
  if (!UUID.test(id) || !(await removeKnowledgeRelation(projectId, id))) {
    throw refuse(
      'MODULE_MAP_NODE_NOT_FOUND',
      `no relation of this project is "${id}": name it by the id a relation write or the tree answered`,
      '/relationId',
    );
  }
  return { removed: id };
}
