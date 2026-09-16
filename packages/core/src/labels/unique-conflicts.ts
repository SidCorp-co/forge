import { isUniqueViolation, uniqueViolationConstraint } from '../lib/db-errors.js';

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
export function labelUniqueConflict(err: unknown): { code: string; message: string } | undefined {
  if (!isUniqueViolation(err)) return undefined;
  return BY_CONSTRAINT[uniqueViolationConstraint(err) ?? ''];
}
