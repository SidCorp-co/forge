// Side-effect module: importing it initialises Sentry.
//
// It exists because a bare `initSentry()` call cannot run early enough. ESM
// hoists every `import` declaration and evaluates all of them before a single
// statement of the importing module's body, so `index.ts`'s
//
//     import { initSentry } from './observability/sentry.js';
//     initSentry();
//     import { adminRoutes } from './admin/routes.js';   // ...and 170 more
//
// ran the init AFTER all 170 of those modules had been evaluated — the exact
// opposite of what its comment claimed, and it claimed it for the one case that
// matters. A module that throws at import time, which is why config/env.ts
// exists, produced an unreported crash: Sentry was not attached yet.
//
// Module EVALUATION order does follow import order, so a side-effect import
// placed first genuinely runs first. Verified 2026-08-25 with a four-module
// repro before this file was written.

import { initSentry } from './sentry.js';

initSentry();
