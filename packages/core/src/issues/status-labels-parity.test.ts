import { ISSUE_STATUS_LABELS as CONTRACT_LABELS } from '@forge/contracts';
import { describe, expect, it } from 'vitest';
import { issueStatuses } from '../db/schema.js';
import { ISSUE_STATUS_LABELS } from './status-sets.js';

describe('the core and contracts copies of the status labels', () => {
  it('name every status the schema holds', () => {
    expect(Object.keys(ISSUE_STATUS_LABELS).sort()).toEqual([...issueStatuses].sort());
  });

  it('say the same words for each', () => {
    expect(ISSUE_STATUS_LABELS).toEqual(CONTRACT_LABELS);
  });
});
