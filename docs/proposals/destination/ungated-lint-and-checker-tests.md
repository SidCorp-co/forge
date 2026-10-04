# What no gate reaches

Two things were met while the comment axis existed and outlived it: that axis and its
`check-comment-budget` gate were removed on 2026-10-04 with the rest of codemap. Each needs a
decision rather than a diff.

## 1. `pnpm lint:code-quality` is measured by nothing

`eslint.config.mjs` keeps its four comment rules off, and what the command still reports belongs to
no axis. Measured on 2026-09-20 over 2,239 files:

| Half | Findings | Whose axis |
|---|---|---|
| `no-raw-elements` | 165 | none declared |
| `no-pass-through-wrapper` | 84 | none declared |
| crowded directories | 48 | none declared |
| unknown design tokens | ~5,370 | none declared |
| raw colours, arbitrary sizes in stylesheets | 2 | none declared |

Importing roughly 5,400 unjudged findings into one axis would make that axis mean nothing, and
`check-size-budget` already owns length. So they stay where they were — reported by a command a
person runs by choice.

The unknown-token figure is worth a reading before anyone freezes it. The sweep resolves tokens
against `code-quality.json`'s `tokenFile`, `packages/web-v2/src/styles/tokens.css`, while the
ESLint half resolves against `packages/web-v2/src/app/globals.css`. Two files, one question, and
findings like `text-embedding-3-small — unknown token --color-embedding-3-small` in
`packages/core/src/config/env.ts` — a model name read as a Tailwind utility. Whether that number
is debt or noise is not established, and freezing it before it is established would freeze the
noise.

## 2. The checkers' own tests run, and the behaviour axis never judges them

Found while adding one. `scripts/lib/` holds 16 `*.test.mjs` files. `check-test-reachability`
sees them — 551 tracked test files, all collected by four runners — because
`packages/core/vitest.config.ts` includes `../../scripts/**/*.test.mjs` and nothing else does.
`check-test-signal` does not: `checkers.test-signal` in `.forge/conformance.json` scans six roots
under `packages/`, none of them `scripts/`, and matches `.test.ts` and `.test.tsx`, neither of
which is `.mjs`.

So the suites that hold every other gate are collected and run, and whether they assert behaviour
or restate a declaration is measured by nothing. That is one half of the shape ISS-1111 was filed
about, in the directory that implements the fix.

Widening the scan is two lines in the manifest. It is not a two-line change: `check-test-signal`
carries a frozen baseline under `improves: down`, so 16 previously unmeasured files arrive at
once and whatever they carry has to be either paid or frozen — and freezing is an amnesty, which
is a decision rather than an edit.

## Honest costs

| Choosing this | Costs |
|---|---|
| Declaring a design axis for the ungated halves | A baseline over roughly 5,400 findings, most of them from one sweep whose token source disagrees with ESLint's — so the freeze would record noise as debt and a reader would learn to skip the report. |
| Leaving all of it as it stands | The design halves keep reporting to nobody, and the checkers' own tests stay unjudged — written and unmeasured. |
| Widening test-signal to `scripts/` and `.test.mjs` | 16 files arrive at a level-2 axis at once: each one either pays what it carries or is frozen, and a freeze here is an amnesty over the suites that hold every other gate. |

## What would settle it

For 1: one reading of the unknown-token sweep against a single token source, to learn whether that
5,370 is debt or a misconfiguration.
For 2: one run of `check-test-signal` widened to those 16 files, to learn whether the answer is a
payment or an amnesty.
