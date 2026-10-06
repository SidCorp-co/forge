# A test reading a named file outside its package is not selected by a change to that file

**Removed when:** a test declares the files outside its package that it reads, and a checker refuses
a declared path the running job's filter does not match, which dev ISS-134 carries. The change that
lands it deletes this file.

ISS-1314 made a test whose input is the whole repository run on every change, selected by the
`@gate-input whole-tree` line it carries. It left alone a narrower case of the same mechanism: a
test that reads ONE named file outside the paths its CI job is selected by. A change to that file
alone skips the job, and `ci-passed` reads the skip as a pass. The issue's own rules put it out of
reach there, since they allowed only whole-tree tests to change selection.

## The reads

Measured on the tree ISS-1314 was cut from, seven TypeScript tests in `packages/core` and
`packages/web-v2` read a named file outside their job's filter — among them the core tests that read
the runner's wire fixtures. Those tests were deleted on dev with every TypeScript test, and the
runner's own tests with its fixtures (ISS-216). Re-measured after the QA phase rewrote the core and
web suites (ISS-172): none reads a named file outside its package, and the one test that loads
another package's file, `scripts/lib/unit-config-workers.test.mjs`, declares `@gate-input whole-tree`.

## What would close it

Each test declares the named paths it reads outside its package, and a checker that runs in every
pull request refuses a declared path that the filter of the job running the test does not match.
That keeps the filter as the selection and makes it answer to the declarations, rather than asking
someone to remember to add a line when a test starts reading a new file.

## Honest costs

| Cost | What it takes |
|---|---|
| A second declaration shape | `@gate-input` would carry paths as well as `whole-tree`, and the checker has to parse `ci.yml`'s filters, which today only `dorny/paths-filter` reads. |
| The Rust side | a Rust test is not a vitest file, so its declaration needs a reader of its own, or the runner filter takes the path by hand. |

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
can write back.

So "every undeclared test that lists the root is refused" cannot be met by observation.
ISS-1314's criterion 8 was corrected to the routes the guard observes, with criterion 19 for what
it cannot read.

| Cost | What it takes |
|---|---|
| Kernel-level tracing | Closing native code needs every directory enumeration traced (strace, seccomp or eBPF on `getdents64`) and attributed to the one test file that caused it. That means one file per process, and a Linux-only gate. |
| Nothing closes delegation from inside | A listing made by a process the test did not start is visible only to that process. The honest guard for it is the declaration itself, written by whoever knows what the service reads. |

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
