import { and, count, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issueLabels, type LabelKind, labels } from '../db/schema.js';

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
  | 'PARENT_ON_NON_MODULE';

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

/** `parentId` belongs to a module and to nothing else — a plain label with a parent is a row the hierarchy cannot mean anything about. */
export function assertParentIsForModule(isModule: boolean): void {
  if (!isModule) {
    throw new ModuleHierarchyError(
      'PARENT_ON_NON_MODULE',
      'only a module can have a parent; set kind to module, or clear parentId',
    );
  }
}
