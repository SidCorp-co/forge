# Hoisting is kept, the gigabytes are elsewhere, and what it hides is the reason to look again

`.npmrc` at the repository root has set `node-linker=hoisted` and `shamefully-hoist=true` since
ISS-136 created this workspace, under a comment that read *"Strapi and some plugins expect flat
node_modules"*. This repository has no Strapi: the only occurrence of the word in a manifest is
`packages/core`'s own description, *"RFC 0002 Strapi replacement"*. ISS-1287 was filed on that,
and on the belief that the setting costs every worktree gigabytes of disk.

The reason was dead. The cost was not there. This page is the measurement, so the same premise
does not open the same issue again, and the residual the decision leaves standing.

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

The bolded row is the whole of the difference, and it is an upper bound rather than a reclaimable
figure: an inode this store does not name may still be hardlinked from another checkout, and the
measurement does not look outside the tree. On total blocks, on non-store blocks, on total distinct
inodes and on directory entries the isolated linker is the **larger** of the two. Install time
separated them by less than the run-to-run spread — 3.0 s and 8.5 s on two hoisted installs against
3.5 s and 3.4 s on two isolated ones, the store already warm for all four.

`virtualStoreType: global`, which ISS-1287 names as the shape worth reaching for, does not exist in
the pnpm this repository pins. `packageManager` in the root `package.json` reads `pnpm@9.15.0`;
`grep -c virtualStoreType` over that release's `pnpm.cjs` returns 0 and `pnpm config get
virtual-store-type` answers `undefined`. Reaching it is a pnpm major upgrade, which is a different
piece of work from this one.

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

Four things resolve from the repository root a package that only `@forge/core` declares, and reach
it only because the tree is flat:

| resolved from the root by | the package it needs |
|---|---|
| `scripts/verify.mjs`, in its `pnpm exec biome check scripts` check | `@biomejs/biome` |
| `scripts/check-integration-declarations.mjs`, spawning `node_modules/.bin/tsx` | `tsx` |
| `.forge/archmap/src/providers/ts.mjs`, walking the root for its bin | `dependency-cruiser` |
| `.arch-tsconfig.json`, mapping `hono/*` to `node_modules/hono/dist/*` | `hono` |

Remove the two settings and nothing else, and `pnpm verify` loses five verdicts: `form scripts
lint` goes red with `Command "biome" not found`, and `relations archmap`, `form
integration-declarations`, `meta conformance levels` and `meta conformance audit` report that they
could not run. Declaring the three tools at the root with `pnpm add -w -D` clears all five and
leaves a sixth: `meta conformance audit` R7 then runs and fails, its unresolvable-edge count having
gone from 33 to 208 against a ceiling of 50, because the `hono/*` mapping above no longer resolves.

Two things that were expected to be coupled are not. `pnpm build`, web-v2's `next build` among it,
and `pnpm deploy --filter=@forge/core --prod` — the line `packages/core/Dockerfile` builds the
production image with — both succeeded under the isolated linker.

## The residual this leaves standing

A flat `node_modules` lets any package import anything any other package declares, and nothing in
this repository's gate catches it. The four couplings above are that defect already realised, found
only because this issue went looking; the reason they are named in `.npmrc` rather than repaired is
that the comment naming them is what makes them visible at all. Whoever revisits this should expect
the list to have grown.

The isolated linker is what would catch them, and this measurement says it is affordable — it costs
13 MB and about five thousand directory entries per worktree, not gigabytes. What it is not is free:
the six verdicts above have to be repaired first, and the `hono/*` repair means editing the
resolution map that `.arch-tsconfig.json`'s own opening records as having silently emptied three
locked contracts once before.

## Honest costs

- **The unjustified setting is now a justified one, which makes it harder to remove later.** A
  comment naming four consumers reads as a reason to keep it; the list is evidence of a defect, and
  a later reader may take it for a design.
- **Four undeclared root dependencies stay undeclared.** `@biomejs/biome`, `tsx`,
  `dependency-cruiser` and `hono` are used from the root and declared only by `@forge/core`. Any
  version bump in that package moves a tool the root gate runs, with nothing recording the link.
- **The measurement is one box, one warm store, one worktree.** A store on a different filesystem
  from the checkout cannot hardlink, and there the numbers here do not hold.
- **Nothing was done about the gigabytes.** The `target/` and `.next/` directories this page points
  at are measured and left; the issue put worktree pruning out of scope, so that cost is still paid
  on every tree.
