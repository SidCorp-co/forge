// ISS-276 / FB-87: the account printed 19:30Z and answered at 16:42Z. A runner is held until its next
// try, so the no-capacity notice tells the operator to wait for that, never for the provider reset.

import { describe, expect, it } from 'vitest';
import { wedgeCopy } from './retry.js';

describe('the no-capacity notice when every runner is limited', () => {
  const copy = wedgeCopy(true, 2, 0, { scope: 'this project' });

  it("says to wait for a runner's next try, which an answered turn brings sooner", () => {
    expect(copy.action).toBe("raise the account limit, or wait for a runner's next try");
    expect(copy.nextStep).toContain('tries each limited runner again at its next try');
    expect(copy.nextStep).toContain('a turn its account answers frees it sooner');
  });

  it('never tells the operator to wait for the reset an account printed', () => {
    for (const text of [copy.action, copy.nextStep, copy.summary, copy.title]) {
      expect(text).not.toMatch(/wait for the (provider|printed) reset/i);
    }
    expect(copy.nextStep).toContain(
      'The reset an account printed is its claim, not when work resumes.',
    );
  });
});
