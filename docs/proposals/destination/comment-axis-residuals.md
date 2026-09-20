# What the comment gate does not reach

ISS-1111 put comment content behind a gate: `check-comment-budget` freezes the four rules
`eslint.config.mjs` enables out of `.forge/code-quality`, and `conformance-status.mjs` holds the
manifest to it. ISS-1105 stopped those rules measuring a machine directive as prose.

Three things were met on the way and none fits inside either issue. Each needs a decision rather
than a diff.

## 1. The vendored plugin has no recorded upstream

`.forge/code-quality/` is `eslint-plugin-code-quality@0.15.0`, vendored the way `.forge/archmap/`
is. `archmap` carries a `VERSION` file and a `MANIFEST.json`; `code-quality` carries neither, and
nothing anywhere in this repo names where it came from.

ISS-1105 changed six of its source files — `line-metrics.js`, `index.js` and the four comment
rules — to let a project name its own directive vocabularies through
`configure({ additionalDirectives })`. The change was deliberately written to be upstreamable
rather than repo-specific: the built-in vocabulary is unchanged and always applies, and this
repo's two names live in `eslint.config.mjs`, not in the plugin.

It is still a local patch nobody can find. A `pnpm update` of that directory, or a re-vendor from
whatever the upstream is, silently reverts it, and the 42 findings it removed come back with no
line in any diff explaining why.

The three answers, in the order they cost:

1. **Record the provenance** — a `VERSION` and a `MANIFEST.json` beside `archmap`'s, naming the
   upstream, the vendored version and the local patch. Cheapest; the drift stays, it is merely
   visible.
2. **Upstream `additionalDirectives`** and re-vendor the release that carries it. Removes the
   patch; costs a round trip through a repository this project does not control.
3. **Declare the fork** — rename it, drop the upstream claim, and own the rules here. Removes the
   question; costs every future upstream fix.

## 2. Four halves of `pnpm lint:code-quality` are measured by nothing

That command reports far more than the comment axis. Measured on 2026-09-20 over 2,239 files:

| Half | Findings | Whose axis |
|---|---|---|
| `no-raw-elements` | 165 | none declared |
| `no-pass-through-wrapper` | 84 | none declared |
| crowded directories | 48 | none declared |
| unknown design tokens | ~5,370 | none declared |
| raw colours, arbitrary sizes in stylesheets | 2 | none declared |

The comment gate deliberately does not cover them: importing roughly 5,400 unjudged findings into
one axis would have made that axis mean nothing, and `check-size-budget` already owns length.
So they stay where they were — reported by a command a person runs by choice.

The unknown-token figure is worth a reading before anyone freezes it. The sweep resolves tokens
against `code-quality.json`'s `tokenFile`, `packages/web-v2/src/styles/tokens.css`, while the
ESLint half resolves against `packages/web-v2/src/app/globals.css`. Two files, one question, and
findings like `text-embedding-3-small — unknown token --color-embedding-3-small` in
`packages/core/src/config/env.ts` — a model name read as a Tailwind utility. Whether that number
is debt or noise is not established, and freezing it before it is established would freeze the
noise.

## 3. The checkers' own tests run, and the behaviour axis never judges them

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
| Recording the provenance (1) | One manifest file to keep true; the local patch still diverges from upstream, and a re-vendor still reverts it — visibly rather than silently. |
| Upstreaming the patch (2) | A round trip through a repository this project does not control, on a clock it does not set; the gate carries the local patch meanwhile. |
| Declaring the fork (3) | Every upstream fix to these rules becomes this repo's to port by hand, forever. |
| Declaring a design axis for the ungated halves | A baseline over roughly 5,400 findings, most of them from one sweep whose token source disagrees with ESLint's — so the freeze would record noise as debt and a reader would learn to skip the report. |
| Leaving all of it as it stands | The comment gate holds, and the other four halves keep reporting to nobody — the same shape ISS-1111 was filed to end, one axis over. |
| Widening test-signal to `scripts/` and `.test.mjs` | 16 files arrive at a level-2 axis at once: each one either pays what it carries or is frozen, and a freeze here is an amnesty over the suites that hold every other gate. |

## What would settle it

For 1: the upstream's name. Nothing in this repo has it, and no commit message names it.
For 2: one reading of the unknown-token sweep against a single token source, to learn whether that
5,370 is debt or a misconfiguration.
For 3: one run of `check-test-signal` widened to those 16 files, to learn whether the answer is a
payment or an amnesty.
