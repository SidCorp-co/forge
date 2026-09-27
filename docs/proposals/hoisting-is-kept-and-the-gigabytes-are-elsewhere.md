# Hoisting is kept, the gigabytes are elsewhere, and what it hides is the reason to look again

`.npmrc` at the repository root has set `node-linker=hoisted` and `shamefully-hoist=true` since
ISS-136 created this workspace, under a comment that read *"Strapi and some plugins expect flat
node_modules"*. This repository has no Strapi: the only occurrence of the word in a manifest is
`packages/core`'s own description, *"RFC 0002 Strapi replacement"*. ISS-1287 was filed on that,
and on the belief that the setting costs every worktree gigabytes of disk.

The reason was dead. The cost was not there. This page is the measurement, so the same premise
does not open the same issue again, and the residual the decision leaves standing.

## Where this has to be measured, and why the first attempt could not fail

**Every figure below about *what breaks without hoisting* was re-taken outside every forge-core
checkout, in a clone at `/home/dev/forge-iss1287-probe`.** The first version of this page and of
the `.npmrc` comment was measured inside `.claude/worktrees/<issue>/`, and that is not a place this
measurement can be taken.

A worktree under `.claude/worktrees/` sits *inside* the parent checkout. Node resolves a bare
specifier by walking up from the importing file, so from
`<repo>/.claude/worktrees/x/scripts/check-lazy-module-init.mjs` the walk leaves the worktree and
reaches `<repo>/node_modules` — the parent's **hoisted** tree. Installing the worktree with the
isolated linker changes nothing about that parent. `require.resolve('typescript')` from inside an
isolated worktree answers `<repo>/node_modules/typescript/lib/typescript.js`.

The leak runs one way only: it can **hide** a missing dependency and can never invent one. So a
measurement of "what still works without hoisting" taken there has no failure mode — it is not
weak evidence of the settings being unnecessary, it is no evidence at all. Re-taken outside, it
found one more package, two more `pnpm verify` verdicts, and `pnpm build` and `pnpm test` failing
where the first run recorded them passing.

Two things will re-hide it for the next person:

- **Turborepo's cache.** `pnpm build` and `pnpm test` are turbo tasks, and turbo hashes each
  package's own inputs — which do not include the node_modules layout. A `pnpm build` run under
  the isolated linker after a hoisted one comes back `FULL TURBO, 4 successful` having run
  nothing. Re-measure with `--force`, or with `TURBO_CACHE_DIR` pointed somewhere empty.
- **A scratch directory with a very large parent.** Run from
  `/home/dev/.cache/forge-tmp/<...>/`, `biome` stopped applying `scripts/biome.json` and
  `form scripts lint` and `form lint-budget` both went red on formatting, under *both* linkers.
  The same tree at `/home/dev/forge-iss1287-probe` is green. That is an artefact of the probe's
  location and not of this repository; it is recorded here only so the next person does not read
  it as a finding.

## What a worktree's node_modules actually costs it

pnpm hardlinks package files out of its content-addressable store under **both** linkers. What a
worktree pays is therefore not what `du` reports but the blocks in inodes the store does **not**
also name; the rest are the store's blocks, counted again by every traversal that walks them.

Measured 2026-09-27 in one worktree, both layouts against one warm store at
`~/.local/share/pnpm/store/v3`, which `stat -c %d` puts on the same filesystem device as the
checkout. Each layout was installed into an emptied tree, so neither was measured over the other's
leftovers. Under `LC_ALL=C`, which is the collation `join` requires:

```
find node_modules packages/*/node_modules -xdev -printf '%i %b\n' | sort -u -k1,1  > tree.txt
find "$STORE/files" -xdev -printf '%i\n'                          | sort -u        > store.txt
join    -1 1 -2 1 tree.txt store.txt | awk '{s+=$2} END {print s*512/1048576, "MB in store"}'
join -v1 -1 1 -2 1 tree.txt store.txt | awk '{s+=$2} END {print s*512/1048576, "MB not"}'
```

`%i` is the inode and `%b` its 512-byte blocks. `sort -u -k1,1` counts each distinct inode once, so
an inode carrying several names inside the tree is not summed twice. There is deliberately no
`-type` filter: directories and symlinks are the storage the two layouts differ in, and excluding
them hides the only columns where they differ at all. The lexical sort is load-bearing — on a
fixture of tree inodes `2, 10` against store inodes `2, 3, 10`, a numerically sorted `join` matched
1 of 2 and printed `input is not in sorted order`, while the `LC_ALL=C` sort matched 2 of 2.

| | `node-linker=hoisted` | default isolated |
|---|---:|---:|
| `du -sh --total node_modules packages/*/node_modules` | 1.2 GB | 1.3 GB |
| blocks over distinct inodes | 1219.3 MB · 56,685 inodes | 1232.3 MB · 61,535 inodes |
| of those, in inodes the store also names | 1196.0 MB · 50,877 | 1195.9 MB · 50,875 |
| **of those, in inodes the store does not name** | **23.3 MB · 5,808** | **36.3 MB · 10,660** |
| directory entries | 62,623 | 67,343 |

**Both non-store figures are install-fresh, and the tree has to be unrun for them to come back.**
The same measurement on a tree that had run `pnpm build` and `pnpm test` once reads
`53.6 MB · 7,140 inodes` under hoisting — `node_modules/.vitest-cache` and
`packages/core/node_modules/.cache/tsc/*.tsbuildinfo` more than double it, which is larger than the
13 MB the comparison below turns on. Re-measure after `pnpm install` into an emptied tree, not
after a gate run.

The bolded row is the whole of the difference, and it is an upper bound rather than a reclaimable
figure: an inode this store does not name may still be hardlinked from another checkout, and the
measurement does not look outside the tree. On total blocks, on non-store blocks, on total distinct
inodes and on directory entries the isolated linker is the **larger** of the two. Install time
separated them by less than the run-to-run spread — 3.0 s and 8.5 s on two hoisted installs against
3.5 s and 3.4 s on two isolated ones, the store already warm for all four.

`virtualStoreType: global`, which ISS-1287 names as the shape worth reaching for, does not exist in
the pnpm this repository pins. `packageManager` in the root `package.json` reads `pnpm@9.15.0`, and
`virtualStoreType` appears nowhere in that release's `dist/`. The control matters, because the
first attempt at this grep hit `bin/pnpm.cjs`, a 999-byte launcher where every setting returns
zero: over `dist/`, `nodeLinker` appears 39 times, `virtualStoreDir` 278, `preferWorkspacePackages`
12 and `shamefullyHoist` 6, while `virtualStoreType` appears 0. `pnpm config get
virtual-store-type` answers `undefined` beside it. Reaching that shape is a pnpm major upgrade,
which is a different piece of work from this one.

## Where a worktree's gigabytes are

Measured the same day on two live worktrees under `.claude/worktrees/`:

| tree | whole tree | `packages/runner/target` | `packages/web-v2/.next` | `node_modules` |
|---|---:|---:|---:|---:|
| `iss-1191-doctor-fix` | 6.8 GB | 5.1 GB | 420 MB | 1.3 GB |
| `iss-1275-surface` | 1.8 GB | — | 455 MB | 1.3 GB |

The `node_modules` column is the one that is almost entirely the store's, per the split above. A
Rust `target/` is not: `cargo` writes real bytes, and one of them is three quarters of that tree.
Anyone measuring the cost of a worktree should start there and at `.next/`, not here.

## What is kept, and what holds it up

Six packages are imported by code that does not declare them, and reach a repository root that only
hoisting puts them in:

| reached from | the package it needs | declared by |
|---|---|---|
| `scripts/verify.mjs`, in its `pnpm exec biome check scripts` check | `@biomejs/biome` | `@forge/core` |
| `scripts/check-lint-budget.mjs`, running `npx biome` inside `packages/web-v2` | `@biomejs/biome` | `@forge/core` |
| `scripts/check-integration-declarations.mjs`, spawning `node_modules/.bin/tsx` | `tsx` | `@forge/core` |
| `.forge/archmap/src/providers/ts.mjs`, walking the root for its bin | `dependency-cruiser` | `@forge/core` |
| `.arch-tsconfig.json`, mapping `hono/*` to `node_modules/hono/dist/*` | `hono` | `@forge/core` |
| `scripts/check-lazy-module-init.mjs`, its opening `import ts from 'typescript'` | `typescript` | core, contracts, observability, web-v2 |
| `packages/web-v2/src/vitest.setup.ts`, its `import { configure } from '@testing-library/dom'` | `@testing-library/dom` | **nobody** — a transitive of `@testing-library/react` |

The census behind that table is every bare specifier imported by a file under `scripts/` or
`.forge/`, every binary those files spawn, and `.arch-tsconfig.json`'s `paths`, each checked for
`node_modules/<pkg>/package.json` at the repository root of an isolated install. It is a
file-existence test rather than `require.resolve`, which is what makes it immune to the leak the
first section describes. `vitest`, `eslint` and `typescript-eslint` come up in that sweep and are
not on the list: `eslint` and `typescript-eslint` are declared by the root manifest, and `vitest`
is reached only from `scripts/*.test.mjs`, which resolve from the package that runs them.

Remove the two settings and nothing else, and:

- **`pnpm verify` loses seven verdicts.** `form scripts lint` goes red with `Command "biome" not
  found`; `form lazy-module-init` goes red with `ERR_MODULE_NOT_FOUND: Cannot find package
  'typescript'`; and `form lint-budget`, `form integration-declarations`, `relations archmap`,
  `meta conformance levels` and `meta conformance audit` each report that they could not run.
  Twenty-five verdicts pass under hoisting at the same head and in the same clone.
- **`pnpm build` fails**, at `web-v2`'s `next build`: `src/vitest.setup.ts(2,27): error TS2307:
  Cannot find module '@testing-library/dom' or its corresponding type declarations.` Run `--force`
  against an empty cache, `0 cached, 4 total`. This is the claim the first version of this page got
  exactly backwards, and it got it backwards because the parent checkout supplied the package.
- **`pnpm test` fails**, at `web-v2#test`, on the same import in the same setup file: `Failed to
  resolve import "@testing-library/dom" from "src/vitest.setup.ts"`. Also `--force`,
  `0 cached, 6 total`.
- **`pnpm deploy --filter=@forge/core --prod` succeeds.** The line `packages/core/Dockerfile`
  builds the production image with is the one thing measured here that does not need hoisting.

Declaring the three spawned tools at the root with `pnpm add -w -D` clears four of the seven verify
verdicts and turns `meta conformance audit` from unable-to-run into a failure: R7 then runs and
fails, its unresolvable-edge count having gone from 33 to 208 against a ceiling of 50, because the
`hono/*` mapping above no longer resolves. It does nothing for `form lazy-module-init` or for the
two web-v2 failures, which need `typescript` at the root and `@testing-library/dom` declared by
`web-v2`.

One diagnostic misleads while this is being measured. Under the isolated linker
`check-archmap-ready` reports *"dependency-cruiser is installed but carries no
bin/dependency-cruise.mjs … (dependency-cruiser 18.3.0 renamed it)"*. That string is a fixed
prerequisite message keyed on the absence of `node_modules/dependency-cruiser/bin/dependency-cruise.mjs`
at the root, and it fires whatever put the path out of reach. Here the version is 18.2.0 and the
bin is present at `packages/core/node_modules/dependency-cruiser/bin/dependency-cruise.mjs`; what
is absent is the hoisted copy. The message names a cause that is not the cause.

## The residual this leaves standing

A flat `node_modules` lets any package import anything any other package declares, and nothing in
this repository's gate catches it. The seven couplings above are that defect already realised,
found only because this issue went looking twice; the reason they are named in `.npmrc` rather than
repaired is that the comment naming them is what makes them visible at all. Whoever revisits this
should expect the list to have grown — it grew by three between the first measurement and the
second, and the only thing that changed was where the measurement was taken.

**Nothing enforces that list.** The census above is a procedure in a document, not a check
`pnpm verify` runs, so the comment in `.npmrc` is true on the day it was written and unpoliced
afterwards. A checker that fails when a root-level consumer imports a package no root manifest
declares and `.npmrc` does not name is the shape that would end this, and it is not built here for
one reason worth stating: it would land red on the seven rows above, so it needs a baseline and a
declared axis owner, and where a new gate rule goes is a decision this repository does not let a
checker make. That is the next piece of work on this, and it is the one that stops the drift.

The isolated linker is what would catch all of it, and this measurement says the disk cost is
affordable — 13 MB and about five thousand directory entries per worktree, not gigabytes. What it
is not is cheap in work: seven verify verdicts, `pnpm build` and `pnpm test` have to be repaired
first, `@testing-library/dom` has to be declared by `web-v2`, and the `hono/*` repair means editing
the resolution map that `.arch-tsconfig.json`'s own opening records as having silently emptied
three locked contracts once before.

## Honest costs

- **The unjustified setting is now a justified one, which makes it harder to remove later.** A
  comment naming seven consumers reads as a reason to keep it; the list is evidence of a defect, and
  a later reader may take it for a design.
- **Six undeclared dependencies stay undeclared.** `@biomejs/biome`, `tsx`, `dependency-cruiser`,
  `hono` and `typescript` are used from the root and declared only by packages beneath it, and
  `@testing-library/dom` is imported by `web-v2` and declared by no manifest in this workspace at
  all. Any version bump in those packages moves a tool the root gate runs, with nothing recording
  the link.
- **The list is documented, not gated.** See the residual above: the next person to add a root-level
  consumer will not be told they have, and the comment in `.npmrc` will be wrong again in exactly
  the way it was wrong the first time.
- **The measurement is one box, one warm store, one clone.** A store on a different filesystem
  from the checkout cannot hardlink, and there the disk numbers here do not hold.
- **Nothing was done about the gigabytes.** The `target/` and `.next/` directories this page points
  at are measured and left; the issue put worktree pruning out of scope, so that cost is still paid
  on every tree.
