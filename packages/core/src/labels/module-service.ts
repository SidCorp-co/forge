import { and, count, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, knowledgeEntries, type LabelKind, labels } from '../db/schema.js';

/**
 * ISS-593 — the module half of the labels table. A module IS a label with
 * `kind='module'`; everything here is the part SQL cannot express about one:
 * that a parent is a module in the same project, that the hierarchy stays
 * acyclic, and that a module always has a colour.
 */

// cm:guard the code IS the contract — REST returns it as `cause.code` and MCP as the `CODE: message` prefix, and both are asserted. A caller distinguishes "that parent does not exist here" from "that parent is a plain label" only by this string.
export type ModuleErrorCode =
  | 'INVALID_PARENT'
  | 'PARENT_NOT_MODULE'
  | 'CIRCULAR_HIERARCHY'
  | 'MODULE_IN_USE'
  | 'PARENT_ON_NON_MODULE'
  | 'INVALID_KNOWLEDGE_NODE'
  | 'KNOWLEDGE_NODE_NOT_IN_PROJECT'
  | 'KNOWLEDGE_NODE_TAKEN'
  | 'KNOWLEDGE_NODE_ON_NON_MODULE';

export class ModuleHierarchyError extends Error {
  constructor(
    readonly code: ModuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleHierarchyError';
  }
}

// cm:why the palette is the one web-v2 already renders labels with, so an auto-coloured module is indistinguishable from a hand-coloured one. Kept here rather than in routes.ts because the derivation is a property of a module, not of the endpoint that happens to create it.
const MODULE_PALETTE = [
  '#1f6f4a',
  '#8a3b52',
  '#2f5d8a',
  '#8a5a1f',
  '#5c3f8a',
  '#1f7a7a',
  '#8a2f2f',
  '#4a6b1f',
] as const;

/**
 * A stable colour for a module created without one. Deterministic on the name, so a module
 * deleted and re-created comes back the same colour rather than shuffling under the reader.
 */
export function autoModuleColor(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 0x7fffffff;
  }
  return MODULE_PALETTE[hash % MODULE_PALETTE.length] ?? MODULE_PALETTE[0];
}

/**
 * Validate a `parentId` for the module `labelId` would become (or already is).
 *
 * Three refusals, each by its own code: a parent outside this project or absent
 * (`INVALID_PARENT`), a parent that is a plain label (`PARENT_NOT_MODULE`), and a parent whose
 * own ancestry runs back through `labelId` (`CIRCULAR_HIERARCHY`). `labelId` is undefined on
 * create, where no cycle is reachable because nothing points at a row that does not exist yet.
 */
export async function assertParentIsLegal(
  projectId: string,
  parentId: string,
  labelId: string | undefined,
): Promise<void> {
  if (labelId !== undefined && parentId === labelId) {
    throw new ModuleHierarchyError('CIRCULAR_HIERARCHY', 'a module cannot be its own parent');
  }

  const parent = await loadModuleRow(parentId);
  if (!parent || parent.projectId !== projectId) {
    throw new ModuleHierarchyError(
      'INVALID_PARENT',
      'parentId does not name a label in this project',
    );
  }
  if (parent.kind !== 'module') {
    throw new ModuleHierarchyError('PARENT_NOT_MODULE', 'parentId must name a module');
  }
  if (labelId === undefined) return;

  // cm:guard walk the ancestry and bound the walk — the FK permits a cycle, so a corrupted chain that already loops would spin here forever rather than answering the request. The seen-set ends it at the first repeat, whichever row the loop closes on.
  const seen = new Set<string>([parentId]);
  let cursor = parent.parentId;
  while (cursor !== null) {
    if (cursor === labelId) {
      throw new ModuleHierarchyError(
        'CIRCULAR_HIERARCHY',
        'that parent is a descendant of this module',
      );
    }
    if (seen.has(cursor)) return;
    seen.add(cursor);
    const next = await loadModuleRow(cursor);
    if (!next) return;
    cursor = next.parentId;
  }
}

async function loadModuleRow(
  id: string,
): Promise<
  { id: string; projectId: string; kind: LabelKind; parentId: string | null } | undefined
> {
  const [row] = await db
    .select({
      id: labels.id,
      projectId: labels.projectId,
      kind: labels.kind,
      parentId: labels.parentId,
    })
    .from(labels)
    .where(eq(labels.id, id))
    .limit(1);
  return row;
}

/**
 * Refuse turning a module back into a plain label while anything still depends on it being one.
 *
 * Promotion (`label` -> `module`) is always legal and is how an existing label joins the taxonomy.
 * Demotion is not, in two cases: a child module would be left parented to a plain label, and an
 * issue would be left with `is_primary = true` on a row that is no longer a module — the exact
 * state `resolveLabelIdsForWrite` refuses to create, which no database constraint can catch.
 */
// cm:guard demotion is the ONE label edit that can break an invariant already committed, because it changes the kind of a row other rows point at — refusing it here is the only check; the partial unique index counts primaries and cannot see what kind they are
export async function assertDemotionIsLegal(labelId: string): Promise<void> {
  const [children] = await db
    .select({ n: count() })
    .from(labels)
    .where(eq(labels.parentId, labelId));
  if ((children?.n ?? 0) > 0) {
    throw new ModuleHierarchyError(
      'MODULE_IN_USE',
      'that module is the parent of another module; re-parent its children first',
    );
  }

  const [primary] = await db
    .select({ n: count() })
    .from(issueLabels)
    .where(and(eq(issueLabels.labelId, labelId), eq(issueLabels.isPrimary, true)));
  if ((primary?.n ?? 0) > 0) {
    throw new ModuleHierarchyError(
      'MODULE_IN_USE',
      "that module is some issue's primary; clear the attribution first",
    );
  }
}

/**
 * ISS-947 — the slug a module's name derives, before uniqueness is applied.
 *
 * Lowercase, non-alphanumerics collapsed to a single `-`, trimmed. A name made entirely of
 * punctuation derives nothing, so it falls back to `module` rather than to the empty string the
 * CHECK would then have to call a valid slug.
 */
// cm:edge lockstep -> packages/core/drizzle/migrations/0216_module_slug_and_knowledge_node.sql — the migration backfills every existing module with this same derivation written in SQL (`lower`, `regexp_replace`, `row_number`). The two must agree, or a module created before the migration and one created after answer to different slugs for the same name.
export function moduleSlugBase(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base === '' ? 'module' : base;
}

/**
 * The slug this module will carry: `base`, or the lowest free `base-<n>` from 2 up.
 *
 * `slugify` is not injective — "API/v2" and "API v2" derive one base — and the issue forbids the
 * backfill failing on a project that already has modules. Refusing here instead would leave two
 * policies for one identity, so both suffix. The chosen slug is returned to the caller in the
 * response body, so the disambiguation is visible rather than silent.
 */
export async function deriveModuleSlug(projectId: string, name: string): Promise<string> {
  const base = moduleSlugBase(name);
  const taken = new Set(
    (
      await db
        .select({ slug: labels.slug })
        .from(labels)
        .where(and(eq(labels.projectId, projectId), isNotNull(labels.slug)))
    ).map((r) => r.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Validate the knowledge node `labelId` would bind to.
 *
 * Four refusals, each by its own code: the node is absent (`INVALID_KNOWLEDGE_NODE`), it belongs to
 * another project (`KNOWLEDGE_NODE_NOT_IN_PROJECT`), another module already names it
 * (`KNOWLEDGE_NODE_TAKEN`), or the row being written is not a module
 * (`KNOWLEDGE_NODE_ON_NON_MODULE`, raised by the caller). `labelId` is undefined on create, where
 * no row can yet hold the binding.
 */
export async function assertKnowledgeNodeIsLegal(
  projectId: string,
  knowledgeEntryId: string,
  labelId: string | undefined,
): Promise<void> {
  const [node] = await db
    .select({ projectId: knowledgeEntries.projectId })
    .from(knowledgeEntries)
    .where(eq(knowledgeEntries.id, knowledgeEntryId))
    .limit(1);
  if (!node) {
    throw new ModuleHierarchyError(
      'INVALID_KNOWLEDGE_NODE',
      'knowledgeEntryId does not name a knowledge entry',
    );
  }
  // cm:guard the FK cannot express this — a node in another project is a binding the "thin per-project registry" cannot mean anything by, and widening the read to swallow it would answer one project's module with another project's documentation.
  if (node.projectId !== projectId) {
    throw new ModuleHierarchyError(
      'KNOWLEDGE_NODE_NOT_IN_PROJECT',
      'that knowledge entry belongs to a different project',
    );
  }

  // cm:guard checked here as well as by `labels_knowledge_entry_id_uq` so the caller gets a code rather than a 500 on a unique violation; the index is what holds when a writer bypasses this path.
  const [owner] = await db
    .select({ id: labels.id })
    .from(labels)
    .where(eq(labels.knowledgeEntryId, knowledgeEntryId))
    .limit(1);
  if (owner && owner.id !== labelId) {
    throw new ModuleHierarchyError(
      'KNOWLEDGE_NODE_TAKEN',
      'another module is already bound to that knowledge entry',
    );
  }
}

/** The knowledge binding belongs to a module and to nothing else — the database says the same thing in `labels_knowledge_entry_chk`, and this is what turns it into a code the caller can act on. */
export function assertKnowledgeNodeIsForModule(isModule: boolean): void {
  if (!isModule) {
    throw new ModuleHierarchyError(
      'KNOWLEDGE_NODE_ON_NON_MODULE',
      'only a module can name a knowledge entry; set kind to module, or clear knowledgeEntryId',
    );
  }
}

/** `parentId` belongs to a module and to nothing else — a plain label with a parent is a row the hierarchy cannot mean anything about. */
export function assertParentIsForModule(isModule: boolean): void {
  if (!isModule) {
    throw new ModuleHierarchyError(
      'PARENT_ON_NON_MODULE',
      'only a module can have a parent; set kind to module, or clear parentId',
    );
  }
}
