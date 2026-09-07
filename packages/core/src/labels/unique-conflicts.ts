import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';

// cm:edge contract -> packages/core/drizzle/migrations/0216_module_slug_and_knowledge_node.sql — the keys are index NAMES as the migration spells them; an index renamed there and not here stops matching and its violation leaves as a 500.
const BY_CONSTRAINT: Record<string, { code: string; message: string }> = {
  labels_project_id_name_uq: {
    code: 'LABEL_NAME_TAKEN',
    message: 'label name already taken in this project',
  },
  labels_project_id_slug_uq: {
    code: 'MODULE_SLUG_TAKEN',
    message: 'another module took that slug while this write was in flight; retry',
  },
  labels_knowledge_entry_id_uq: {
    code: 'KNOWLEDGE_NODE_TAKEN',
    message: 'another module is already bound to that knowledge entry',
  },
};

/**
 * ISS-947 — which of the `labels` unique indexes a 23505 came from, or undefined.
 *
 * Three indexes guard this table now, and `slug` and `knowledge_entry_id` are only reachable by a
 * writer that raced the service's own check.
 */
// cm:guard an unrecognised index returns undefined so the caller RETHROWS — folding it into the nearest known code would answer a knowledge-node race with "label name already taken", which names the wrong field and sends the retry at the wrong fix.
export function labelUniqueConflict(err: unknown): { code: string; message: string } | undefined {
  if (!isUniqueViolation(err)) return undefined;
  return BY_CONSTRAINT[uniqueViolationConstraint(err) ?? ''];
}
