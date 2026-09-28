# A test reading a named file outside its package is not selected by a change to that file

ISS-1314 made a test whose input is the whole repository run on every change, selected by the
`@gate-input whole-tree` line it carries. It left alone a narrower case of the same mechanism: a
test that reads ONE named file outside the paths its CI job is selected by. A change to that file
alone skips the job, and `ci-passed` reads the skip as a pass. The issue's own rules put it out of
reach there, since they allowed only whole-tree tests to change selection.

## The reads, measured on the tree ISS-1314 was cut from

| Test | Reads | Its job | Missing from that job's filter |
|---|---|---|---|
| `packages/core/src/devices/master-limit.test.ts`, `packages/core/src/devices/pool-routes.test.ts`, `packages/core/src/devices/pool-routes-questions.test.ts` | the runner's wire fixtures under `packages/runner/crates/forge-runner-core/assets/` | `core` | `packages/runner/**` |
| `packages/core/tests/integration/question-runner-wire-e2e.test.ts` | the same fixtures | `core-integration` | `packages/runner/**` |
| `packages/core/src/lib/contracts-runtime-exports.test.ts` | `packages/contracts/package.json`, whose `exports` decide whether core starts in the production image | `core` | `packages/contracts/**` |
| `packages/runner/crates/forge-runner-core/src/workspace/orientation.rs` | `.forge/orientation.md` | `runner` | `.forge/**` |
| `packages/web-v2/src/features/docs/help-links.test.tsx` | `.github/mlc-config.json` | `web` | `.github/mlc-config.json` |
| `packages/web-v2/src/features/docs/help-frontmatter.test.ts` | imports `scripts/help-frontmatter.mjs` | `web` | `scripts/**` |

The runner fixtures are the sharpest: they are the wire contract between two packages, and a
runner-only change to one runs the runner's side of it and skips core's.

## What would close it

Each test declares the named paths it reads outside its package, and a checker that runs in every
pull request refuses a declared path that the filter of the job running the test does not match.
That keeps the filter as the selection and makes it answer to the declarations, rather than asking
someone to remember to add a line when a test starts reading a new file.

## Honest costs

| Cost | What it takes |
|---|---|
| More runs of `core` | Every runner-fixture or contracts-manifest change would pay a `core` run, and `core-integration` for the e2e test, whose run was 18m37s on the pull request ISS-1314 measured. |
| A second declaration shape | `@gate-input` would carry paths as well as `whole-tree`, and the checker has to parse `ci.yml`'s filters, which today only `dorny/paths-filter` reads. |
| The Rust side | `orientation.rs` is not a vitest file, so its declaration needs a reader of its own, or the runner filter takes `.forge/orientation.md` by hand. |
