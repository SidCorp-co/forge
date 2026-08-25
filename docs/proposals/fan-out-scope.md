# Fan-out measured per file makes a composition root unsplittable

**Found:** 2026-08-25, while splitting `packages/core/src/index.ts` by responsibility.
**Status:** proposal — the split was reverted, the gate was not touched.

## What happened

`index.ts` is 560 lines with three reasons to change: assemble the Hono app, run the
start sequence, run the ordered shutdown. Splitting it into `app.ts` / `boot.ts` /
`shutdown.ts` typechecked, kept every ordering guard, and passed 395 unit files and
66 integration files. It was reverted anyway, because `archmap check` blocked it.

## The measurement

`no-coordinator-blob` is `type: fan-out, scope: file, max_modules: 6`. Frozen counts
in `.arch.baseline.json` before and after:

| file | before | after |
|---|---|---|
| `index.ts` | 48 | — (drops under the limit) |
| `app.ts` | — | 47 |
| `boot.ts` | — | 18 |
| `shutdown.ts` | — | 9 |

Frozen total 143 → 169. `.forge/conformance.json` declares that baseline
`improves: down`, and `compareDown` fails on a rising total.

## Why the rise is an artifact

The reach sets nest. Measured, not assumed:

```
boot     \ app  = {}    18 modules, all of them already in app's 47
shutdown \ app  = {}     9 modules, all of them already in app's 47
```

Every module the extracted halves touch was already counted in the half that
remains. **The split introduces no dependency the repo did not already have** — the
+26 is the same edges counted two and three times because the unit of measurement is
the file.

This is not specific to the shape chosen. Every extraction duplicates the nested part:

| shape | cost |
|---|---|
| extract boot + shutdown | +26 |
| extract boot only | +17 |
| extract shutdown only | +8 |

There is no free extraction, so the rule as written makes a frozen fan-out blob
**permanently unsplittable**. That is stricter than the ratchet's own stated purpose:
its `cm:guard` in `scripts/lib/baseline-ratchet.mjs` says "debt has to leave for debt
to arrive", written after considering *renames*. A split was not considered, and in a
split the debt does not leave — it is duplicated by the measurement.

## What was rejected, and why

- **An allowance in `.forge/conformance.json`** (a reviewed `sum:` ceiling the ratchet
  compares against). Works, but it is an escape hatch on the one guard whose value is
  that it has none. The next person under a blocked build bumps the number.
- **A per-file exemption in `.arch.json`.** archmap refuses this by design and says so
  in `src/contracts/index.mjs`: widening `tests.relax` to source files "turns the test
  glob into a general exemption list, which is the escape route this design refuses."
- **Reducing `boot.ts` below the limit.** Fan-out counts distinct *modules*, not files,
  so consolidating the ~40 `register*()` calls changes nothing. Reaching fewer modules
  needs a registry, and the registry becomes the blob.

## Shape of a fix, for whoever takes it

Give `fan-out` a `scope: "module"` alongside `scope: "file"`. At module scope the four
files are one module, the nested reach collapses, and the metric stops depending on how
many files a module's coordination is spread across — which is the property that is
missing. `index.ts` would then be one finding at 47 whether it is one file or four.

Not attempted here: `scope` is read by the fan-out evaluator for every contract in the
repo, so adding a second meaning to it is a change to the gate, and a gate is not
something to change while working around it.
