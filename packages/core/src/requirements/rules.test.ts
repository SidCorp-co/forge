/**
 * The revision guards answer with the route that gets the caller out (REQ-34 BC-18): a refusal for a
 * proposed revision never sends its caller to the route that is refused for the same reason.
 */

import { describe, expect, it } from 'vitest';
import { openRevisionRefusal, stateRefusal } from './rules.js';

const RETURN = '…/revisions/2/return';
const WITHDRAW = '…/revisions/2/withdraw';
const REWRITE = 'PUT …/revisions/2';

describe('openRevisionRefusal', () => {
  it('lets nothing through when no revision is open', () => {
    expect(openRevisionRefusal(null)).toBeNull();
  });

  it('sends a proposed revision to the act that unfreezes it, and not to a rewrite it refuses', () => {
    const refusal = openRevisionRefusal({ revision: 2, state: 'proposed' });
    expect(refusal?.code).toBe('REQUIREMENT_REVISION_OPEN');
    expect(refusal?.detail).toContain(`POST ${RETURN}`);
    expect(refusal?.detail).toContain('requirements.approve');
    expect(refusal?.detail).not.toContain(REWRITE);
  });

  it('sends an open draft to the rewrite and the withdraw that free it', () => {
    const refusal = openRevisionRefusal({ revision: 2, state: 'draft' });
    expect(refusal?.code).toBe('REQUIREMENT_REVISION_OPEN');
    expect(refusal?.detail).toContain(REWRITE);
    expect(refusal?.detail).toContain(`POST ${WITHDRAW}`);
  });
});

describe('stateRefusal', () => {
  it('names the return for a proposed revision a write was refused, then the write that follows it', () => {
    const refusal = stateRefusal(2, 'proposed', 'draft');
    expect(refusal?.code).toBe('REQUIREMENT_REVISION_NOT_DRAFT');
    expect(refusal?.detail).toContain(`POST ${RETURN}`);
    expect(refusal?.detail).toContain('requirements.approve');
    expect(refusal?.detail).toContain(REWRITE);
  });

  it('names a new revision as the way to change a current one, which no return reaches', () => {
    const refusal = stateRefusal(2, 'current', 'draft');
    expect(refusal?.code).toBe('REQUIREMENT_REVISION_NOT_DRAFT');
    expect(refusal?.detail).toContain('POST …/revisions');
    expect(refusal?.detail).not.toContain(RETURN);
  });

  it('names the propose that makes a draft acceptable', () => {
    const refusal = stateRefusal(2, 'draft', 'proposed');
    expect(refusal?.code).toBe('REQUIREMENT_REVISION_NOT_PROPOSED');
    expect(refusal?.detail).toContain('POST …/revisions/2/propose');
  });

  it('holds back a withdrawn revision from every route, and passes the state a write wants', () => {
    expect(stateRefusal(2, 'withdrawn', 'draft')?.code).toBe('REQUIREMENT_REVISION_WITHDRAWN');
    expect(stateRefusal(2, 'draft', 'draft')).toBeNull();
    expect(stateRefusal(2, 'proposed', 'proposed')).toBeNull();
  });
});
