# The removed test suites are rewritten, not restored

**Removed when:** ISS-172's QA phase brings the TypeScript suites back on dev and the last cm:hack
ISS-172 marker, `suspendedUntilReturned` in `scripts/lib/suspended-without-tests.mjs`, goes with it.
The change that lands it deletes this file.

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
The integration harness and the release, record, retention, session-context and live-reach suites
are rewritten against dev source; these remain:

| File (`packages/core/tests/integration/`) | Failed |
|---|---|
| `ecosystem-channel-e2e.test.ts` | 11 |
| `ecosystem-channel-notify-e2e.test.ts` | 10 |
| `workflow-design-wake-e2e.test.ts` | 3 |
| `ecosystem-links-e2e.test.ts` | 2 |

Main's nightly CI (run 37238894756) was green over the same files, so these are dev drift, not a
shared defect.

## Honest costs

- Every drifted test is read against the code it now covers and rewritten, which costs more than a
  restore would have.
- The 21 web popover reds and the integration reds still listed above stay unjudged until their
  rewrite lands.
- A restore would be cheaper and would fail for the wrong reason, on symbols dev no longer has.
