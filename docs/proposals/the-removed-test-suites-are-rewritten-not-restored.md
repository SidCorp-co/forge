# The removed test suites are rewritten, not restored

**Removed when:** ISS-172's QA phase brings the TypeScript suites back on dev and the cm:hack ISS-172
markers in `scripts/lib/suspended-without-tests.mjs` and `packages/core/vitest.integration.config.ts`
go with it. The change that lands it deletes this file.

`fce3b8b85` (2026-10-04) removed every TypeScript test suite on dev, and `72e7e7b1c` removed the web
test harness (`vitest.config.ts`, `src/vitest.setup.ts`, `src/types/jest-dom.d.ts`, the
`@testing-library/*`, `jsdom` and `vitest` dependencies). The suites at `fce3b8b85^` (`5da13dd90`) are
a reference for what was covered, not a restore: dev source has moved on under them.

## The web suites have drifted from dev source

Replaying the 205 deleted `packages/web-v2` test files from `fce3b8b85^` against dev source (simplify
census, 2026-10-05): 206 tests in 34 files call a symbol dev has since deleted or reshaped. The
largest, by tests:

| Symbol | Tests | On dev |
|---|---|---|
| `deriveBlockerState` | 41 | gone |
| `flushInvalidations` | 14 | gone |
| `deriveStepOutcomes` | 13 | gone |
| `useCodeTrace` | 11 | `features/modules/hooks.ts` — same name, the tests' shape no longer matches |
| `groupedTransitions` | 10 | gone |
| `useStuckRuns` | 10 | `features/agents/hooks.ts` — same name, the tests' shape no longer matches |
| `allowedTransitions` | 9 | gone |

The popover tests (menu 11, select 10, peek-panel 4, slide-over 4, notifications-menu 4,
command-palette 4, tooltip 3) were the 21 web reds before the removal. They can be judged only
once a harness is back.

## The core integration reds at removal

CI run 37195972829 at dev `7983b6f11` (2026-10-04): 75 failed tests in 15 files, 287 files passing.
Run these first when the integration suite is rewritten:

| File (`packages/core/tests/integration/`) | Failed |
|---|---|
| `record-in-comment-e2e.test.ts` | 13 |
| `retention-sweep-e2e.test.ts` | 11 |
| `ecosystem-channel-e2e.test.ts` | 11 |
| `ecosystem-channel-notify-e2e.test.ts` | 10 |
| `release-hold-e2e.test.ts` | 8 |
| `release-runtime-route-e2e.test.ts` | 7 |
| `release-sweep-e2e.test.ts` | 4 |
| `workflow-design-wake-e2e.test.ts` | 3 |
| `ecosystem-links-e2e.test.ts` | 2 |
| `session-context-expect-e2e.test.ts`, `release-read-model-e2e.test.ts`, `release-hold-times-e2e.test.ts`, `release-blockers-e2e.test.ts`, `live-reach-recorded-head-e2e.test.ts`, `live-reach-e2e.test.ts` | 1 each |

Main's nightly CI (run 37238894756) was green over the same files, so these are dev drift, not a
shared defect.

## Honest costs

- Every drifted test is read against the code it now covers and rewritten, which costs more than a
  restore would have.
- The 21 web popover reds and the 75 integration reds stay unjudged until the rewrite lands.
- A restore would be cheaper and would fail for the wrong reason, on symbols dev no longer has.
