import { describe, expect, it } from 'vitest';
import { labelUniqueConflict } from './unique-conflicts.js';

const violation = (constraint: string) => ({
  query: 'insert into labels ...',
  cause: { code: '23505', constraint_name: constraint },
});

describe('labelUniqueConflict', () => {
  it('names the slug index rather than the name one', () => {
    expect(labelUniqueConflict(violation('labels_project_id_slug_uq'))?.code).toBe(
      'MODULE_SLUG_TAKEN',
    );
  });

  it('names the knowledge-node index rather than the name one', () => {
    expect(labelUniqueConflict(violation('labels_knowledge_entry_id_uq'))?.code).toBe(
      'KNOWLEDGE_NODE_TAKEN',
    );
  });

  it('still answers the name index the way every caller before ISS-947 expected', () => {
    expect(labelUniqueConflict(violation('labels_project_id_name_uq'))?.code).toBe(
      'LABEL_NAME_TAKEN',
    );
  });

  // cm:guard undefined is what makes the route RETHROW — an index this file has not been taught about must reach the caller as a 500 naming it, never as the nearest 409, because a wrong code sends the retry at the wrong field
  it('answers undefined for an index it does not know', () => {
    expect(labelUniqueConflict(violation('labels_some_future_uq'))).toBeUndefined();
  });

  it('answers undefined for a driver error that is not a unique violation', () => {
    expect(labelUniqueConflict({ cause: { code: '23514' } })).toBeUndefined();
    expect(labelUniqueConflict(new Error('boom'))).toBeUndefined();
    expect(labelUniqueConflict(null)).toBeUndefined();
  });
});
