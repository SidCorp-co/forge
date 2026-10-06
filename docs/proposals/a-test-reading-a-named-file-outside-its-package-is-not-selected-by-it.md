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

## Three more a declaration does not reach

ISS-1314's guard refuses an undeclared test that lists a directory covering the root. Three kinds
of reach it leaves unrefused: the first two measured on the tree its fourth build was cut from, the
third priced by its fifth.

### A listing of one directory below the root

A test that lists `docs/`, `.github/` or a sibling package lists a directory below the root. So the
guard does not refuse it, and its job's filter selects it by the paths the test lives under. The
#710 document lived in `docs/`: an undeclared core test running
`globSync('docs/**/*.md', { cwd: <root> })` or `globSync('../../docs/**/*.md')` passes, and a
documents-only pull request skips it (ISS-1314's third judging, plants `wj5-n5` and `wj5-n9`).

What would close it is the same shape as the named-file reads above. The test declares the
directories it lists outside its package, and a checker refuses a declared directory that the
filter of the job running the test does not match.

| Cost | What it takes |
|---|---|
| A guard that knows each test's package | The refusal has to be read against the test's own package, not the root, so a listing inside the package stays free. |
| More declarations | Every test listing a sibling package declares it, and the checker parses `ci.yml`'s filters, as above. |

### What no observer inside a test's own processes can see

The guard watches the `node:fs` calls, the spawns and the workers of a test's process and of every
Node process it starts. It reads each spawned program by its arguments, and counts a program it
cannot see into as the root. Three routes pass through none of that.

- **Native code.** An addon or a WASI instance lists a directory with a call to the kernel that
  no JavaScript wrapper sees. Node's own routes round the wrappers are counted as the root instead:
  `process.binding` of the `fs`, `fs_dir`, `spawn_sync` and `process_wrap` bindings, and
  `process.execve`.
- **A function taken before the guard installed.** The guard is a setup file, so what a test
  process loads before it, vitest's own runtime and a module a `NODE_OPTIONS` preload names, can
  hold a `node:fs` function from before it was wrapped, and a listing through that is not seen. No
  setup file of this repository runs ahead of it: `whole-tree-gates` refuses a config whose
  `test.setupFiles` does not name the guard first. With one ahead of it that took `readdirSync`, a
  test listing the root through what it took passed (ISS-1314's tenth build, measured outside any
  watch, since a run under the guard starts every process it spawns already watched).
- **A listing delegated to a process the test did not start**, such as a server, a daemon or a
  container it talks to over a socket. That process runs outside the test, so nothing the test
  loads is inside it.

What the guard records lives inside the test's process too, so a test that edits it is not
defended: its hits, and the log its children write to. A log found missing, shorter than a read of
it, or holding a line that is no record counts as the root, but one the test empties before the
guard first reads it cannot be told from one nothing wrote to, and a sentinel the test can read it
can write back. The route to the log is armed rather than trusted: every child and worker the watch
starts is handed the log whatever environment the test gave it, and a preload that still finds none
stops its process or worker before the first line rather than letting it run unwatched.

So "every undeclared test that lists the root is refused" cannot be met by observation.
ISS-1314's criterion 8 was corrected to the routes the guard observes, with criterion 19 for what
it cannot read.

| Cost | What it takes |
|---|---|
| Kernel-level tracing | Closing native code needs every directory enumeration traced (strace, seccomp or eBPF on `getdents64`) and attributed to the one test file that caused it. That means one file per process, and a Linux-only gate. |
| Nothing closes delegation from inside | A listing made by a process the test did not start is visible only to that process. The honest guard for it is the declaration itself, written by whoever knows what the service reads. |
| A record the test cannot write | Closing the edited record needs the hits and the log kept where the test's process cannot reach them: a recorder in a process the guard starts before any test code, which the watch only forwards to. That is a process and a round trip per listing, and a test in the forwarding process can still drop or forge what it forwards, so only the kernel-level tracing above closes it whole. Until then the declaration is the cheaper way out for any test that would reach for `Symbol.for('forge.whole-tree-guard')`. |

### A program git runs from the machine's own configuration

The guard reads what git is set to run in the repository it runs in, since a test writing a
fixture decides that: a hook, `core.hooksPath`, `core.fsmonitor`, a filter, diff or merge driver,
an editor, a signer and a transport command each count as the root for the subcommands that run
them, and so does a config file `GIT_CONFIG_GLOBAL` names. git's environment may hold only the
`GIT_*` keys on its allow list, so `GIT_CONFIG_SYSTEM`, `GIT_TEMPLATE_DIR` and `GIT_INDEX_FILE`
are each refused whoever set them.

ISS-1314's ninth build (the closed grammar) also reads the global and system config
(`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, `/etc/gitconfig`) that a call's environment names,
against a base captured before any test ran and written beside the guard's log so every child
process compares against the same base. A base file must be **unchanged** for the call to pass; a
config file the base did not hold — the `.gitconfig` under a `HOME` a test redirected — is trusted
only when every key it sets is on the repository-config allowlist (`REPO_CONFIG_KEYS`). So a test
that points `HOME` at a directory whose `.gitconfig` sets `core.fsmonitor`, then runs `git status`
in a fixture, is now **refused**, and the earlier cost of telling a chosen `HOME` from an inherited
one is paid by that base.

What the closed grammar leaves is the allowlist itself. `REPO_CONFIG_KEYS` is a hand-maintained
list of the keys a fixture may set, and `badConfigKey` refuses every key off it, so a git key added
upstream is refused until someone reviews it onto the list. The cost is on the other side: a
fixture setting a harmless key the list does not name is refused, and the test declares or the
list grows.

| Cost | What it takes |
|---|---|
| Reading the user's config | The base-comparison means a git call is judged against the config as it stood at install; a developer whose global config changes mid-run, or a machine whose `/etc/gitconfig` differs from CI's, reads as a changed base and is refused, so the base is re-captured per run rather than pinned. |
| Maintaining the config-key allowlist | A fixture key off `REPO_CONFIG_KEYS` is refused even when it runs nothing, so each such key is one reviewed line on the list or one declaration on the test. |
