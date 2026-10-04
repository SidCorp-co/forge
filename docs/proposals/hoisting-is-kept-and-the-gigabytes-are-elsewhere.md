# Hoisting is kept, the gigabytes are elsewhere, and what it hides is the reason to look again

**Removed when:** a `pnpm verify` check fails whenever a root-level consumer reaches a package no
root manifest declares, with today's couplings baselined; that change also rewrites the `.npmrc`
comment pointing here, which dev ISS-140 carries. The change that lands it deletes this file.

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

### How to re-take it

Measured at `5b06318a5`. Anywhere with no forge-core checkout above it — `/home/dev` is one,
`<repo>/.claude/worktrees/` is not:

```
git clone <this repo> /home/dev/forge-iss1287-probe
cd /home/dev/forge-iss1287-probe && git checkout <the commit you are judging>
export TURBO_CACHE_DIR="$(mktemp -d)"                       # never the shared cache

# the control
rm -rf node_modules packages/*/node_modules
pnpm install --frozen-lockfile
node scripts/verify.mjs; pnpm build --force; pnpm exec turbo run test --force

# the subject: the linker moves on the command line, so no file is edited
rm -rf node_modules packages/*/node_modules
pnpm install --frozen-lockfile --config.node-linker=isolated --config.shamefully-hoist=false
node scripts/verify.mjs; pnpm build --force; pnpm exec turbo run test --force
pnpm deploy --filter=@forge/core --prod "$(mktemp -d)"
```

The two `verify` runs are what the seven-verdict count is the difference between; read which checks
`could not run`, not the totals. `--force` on both turbo tasks is not optional — see the cache note
above. The package census is a file-existence test against the isolated install's root, which is
the part that must not use `require.resolve`:

```
# after the isolated install, at the repository root
for p in @biomejs/biome tsx dependency-cruiser hono typescript @testing-library/dom; do
  printf '%-22s %s\n' "$p" "$([ -e "node_modules/$p/package.json" ] && echo AT-ROOT || echo ABSENT)"
done
```

Two of the figures are on a different footing and are said so where they appear: the disk split
below needs an install-fresh tree, and `runner cargo gates` and `meta migration-order` are red in a
fresh clone under both linkers for reasons that have nothing to do with the linker.

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

Six packages were imported by code that did not declare them, reaching a repository root that only
hoisting put them in. ISS-207 declared each in the manifest of the code that uses it, except `hono`:

| reached from | the package it needs | declared by |
|---|---|---|
| `scripts/verify.mjs`, in its `pnpm exec biome check scripts` check | `@biomejs/biome` | root |
| `scripts/check-lint-budget.mjs`, running `npx biome` inside `packages/web-v2` | `@biomejs/biome` | `web-v2` |
| `scripts/check-integration-declarations.mjs`, spawning `node_modules/.bin/tsx` | `tsx` | root |
| `.forge/archmap/src/providers/ts.mjs`, walking the root for its bin | `dependency-cruiser` | root |
| `.arch-tsconfig.json`, mapping `hono/*` to `node_modules/hono/dist/*` | `hono` | `@forge/core` only |
| `scripts/check-lazy-module-init.mjs`, its opening `import ts from 'typescript'` | `typescript` | root |
| `packages/web-v2/src/vitest.setup.ts`, its `import { configure } from '@testing-library/dom'` | `@testing-library/dom` | `web-v2` |

The census behind that table is every bare specifier imported by a file under `scripts/` or
`.forge/`, every binary those files spawn, and `.arch-tsconfig.json`'s `paths`, each checked for
`node_modules/<pkg>/package.json` at the repository root of an isolated install. It is a
file-existence test rather than `require.resolve`, which is what makes it immune to the leak the
first section describes. `eslint` and `typescript-eslint` come up in that sweep and are declared
by the root manifest; `vitest` (imported by `scripts/lib/whole-tree-guard.mjs`) and `postgres`
(required by `scripts/export-legacy-project-config.mjs`) are now declared there too.

Before those declarations, removing the two settings and nothing else cost seven `pnpm verify`
verdicts and failed `pnpm build` and `pnpm test` on `web-v2` at `5b06318a5`; `pnpm deploy
--filter=@forge/core --prod` was the one thing measured that did not need hoisting. It has not been
re-measured with the declarations in place. What is known to remain is the `hono/*` mapping: without
hoisting it no longer resolves, and R7's unresolvable-edge count went from 33 to 208 against a
ceiling of 50 when this was last measured.

## The residual this leaves standing

A flat `node_modules` lets any package import anything any other package declares, and nothing in
this repository's gate catches it. The couplings above were that defect already realised, found
only because this issue went looking twice; six are now declared, and `hono` is named in `.npmrc`
because the comment naming it is what makes it visible at all. Whoever revisits this
should expect the list to have grown — it grew by three between the first measurement and the
second, and the only thing that changed was where the measurement was taken.

**Nothing enforces that list.** The census above is a procedure in a document, not a check
`pnpm verify` runs, so the comment in `.npmrc` is true on the day it was written and unpoliced
afterwards. A checker that fails when a root-level consumer imports a package no root manifest
declares and `.npmrc` does not name is the shape that would end this, and it is not built here for
one reason worth stating: it would land red on the `hono` row above, so it needs a baseline and a
declared axis owner, and where a new gate rule goes is a decision this repository does not let a
checker make. That is the next piece of work on this, and it is the one that stops the drift.

The isolated linker is what would catch all of it, and this measurement says the disk cost is
affordable — 13 MB and about five thousand directory entries per worktree, not gigabytes. What it
is not is cheap in work: the verdicts it costs have to be re-measured and repaired first, and the `hono/*` repair means editing
the resolution map that `.arch-tsconfig.json`'s own opening records as having silently emptied
three locked contracts once before.

## Honest costs

- **The unjustified setting is now a justified one, which makes it harder to remove later.** A
  comment naming seven consumers reads as a reason to keep it; the list is evidence of a defect, and
  a later reader may take it for a design.
- **`hono` stays undeclared at the root.** `.arch-tsconfig.json` maps into it and only
  `@forge/core` declares it, so a version bump there moves what the archmap resolves, with nothing
  recording the link.
- **The list is documented, not gated.** See the residual above: the next person to add a root-level
  consumer will not be told they have, and the comment in `.npmrc` will be wrong again in exactly
  the way it was wrong the first time.
- **The measurement is one box, one warm store, one clone.** A store on a different filesystem
  from the checkout cannot hardlink, and there the disk numbers here do not hold.
- **Nothing was done about the gigabytes.** The `target/` and `.next/` directories this page points
  at are measured and left; the issue put worktree pruning out of scope, so that cost is still paid
  on every tree.
