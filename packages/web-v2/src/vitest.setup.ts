// Shared setup for web-v2's unit suite.
//
// One setting lives here and it is the other half of `vitest.config.ts`'s
// `testTimeout` guard: testing-library's async utilities keep their own
// timeout, and raising vitest's did nothing for them.

import { configure } from '@testing-library/dom';

// cm:guard the reason and the measurement are on `vitest.config.ts:testTimeout` rather than repeated
// here, because the two numbers are one decision: this suite's waits are contention budgets on a box
// that runs core's fork pool alongside it, not statements about how long a screen ought to take.
configure({ asyncUtilTimeout: 10_000 });
