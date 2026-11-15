import { describe, expect, it } from 'vitest';
import { actPrompt } from '../steward/prompts.js';
import { DISPATCH_GUIDE } from './dispatch-guide.js';
import { QA_GUIDE } from './qa-guide.js';

// @direct-test-of packages/core/src/guides/qa-guide.ts
// @direct-test-of packages/core/src/guides/dispatch-guide.ts
// @direct-test-of packages/core/src/steward/prompts.ts
//
// ISS-1241 (REQ-48 BC-18, agenfold FB-646): a follow-through judge saw a later landed issue had
// changed a criterion on purpose, wrote so in its own reason, and still recorded a fail, which
// reopened the closed issue. ISS-1240 gave the supersede route and told only the builder. The judge,
// the steward's follow-through and the master each now read what to do, and each sentence is held here.

const flat = (s: string): string => s.split(/\s+/).join(' ');

const NO_REGRESSION =
  'A criterion that no longer holds because a later landed issue changed it on purpose is no regression: record it `skipped`, naming that issue and its criterion, never `fail`';

describe('a criterion a later issue changed on purpose is skipped by its judge and superseded by the master', () => {
  it('the qa guide has the judge skip it naming the later issue, never fail it', () => {
    expect(flat(QA_GUIDE.body)).toContain(NO_REGRESSION);
  });

  it("the steward's follow-through says the same and wakes the master, where it judges a running build", () => {
    const followthrough = flat(actPrompt('release_followthrough'));
    expect(followthrough).toContain(NO_REGRESSION);
    expect(followthrough).toContain('wake the master to supersede it');
  });

  it('the dispatch guide has the master supersede it', () => {
    expect(flat(DISPATCH_GUIDE.body)).toContain(
      'A criterion a judge skipped because a later landed issue changed it on purpose is yours to supersede, so no re-judge reopens its issue: `POST /api/issues/:id/criteria/:n/supersede`',
    );
  });
});
