// Register jest-dom matchers onto the SAME `expect` the test runner uses.
//
// We import `expect` from "vitest" (the runner's own instance — vitest 4 in
// this package) and extend it with the raw matchers, instead of the
// convenience `@testing-library/jest-dom/vitest` entry. That entry resolves
// its own `vitest` peer, which under pnpm hoisting can be a DIFFERENT vitest
// (the workspace also pins vitest 2 for web-v2/core). When the two diverge the
// matchers land on the wrong `expect` and every `toBeInTheDocument()` throws
// "Invalid Chai property". Extending the runner's expect directly is immune to
// that hoisting drift (ISS-397 surfaced it when packages/web was removed).
import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";

expect.extend(matchers);
