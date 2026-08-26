<!-- forge:orientation -->
<!-- Forge-managed pointer (fixed). Project orientation lives in .forge/orientation.md. -->
@.forge/orientation.md
<!-- /forge:orientation -->

# Forge

Open-source control plane for Claude Code — full-stack project management + an AI agent pipeline that drives Claude end-to-end (triage → clarify → plan → code → review → test → release). pnpm + turbo monorepo, root package `forge`.

**Constitution: [`docs/VISION.md`](docs/VISION.md)** — what Forge is / is not, principles (incl. №10 state-never-lies, №11 kernel-hard-policy-soft), roadmap. On intent conflicts, VISION wins.

## Workspace

| Package | What |
|---|---|
| `packages/core` | Hono backend. Single app (`src/index.ts`) mounting per-domain route modules (`src/<domain>/routes.ts`); Drizzle ORM over Postgres (pgvector); WebSocket server (`/ws`); MCP server (`/mcp`, tools in `src/mcp/tools/forge-*.ts`); the pipeline dispatcher that drives Claude. |
| `packages/web-v2` | Next.js cloud UI, canonical at `/`. Feature modules under `src/features/<domain>/`. |
| `packages/runner` | Headless Rust `forge-runner` CLI daemon (crates `forge-runner` / `forge-runner-core`) for servers/CI; pairs as a device. See `docs/architecture/runner-daemon.md`. |
| `packages/contracts` | Shared cross-app TS types & registries (`issues.ts`, `pipeline-registry.ts`, `requests.ts`, `responses.ts`, `rows.ts`, `domain-templates.ts`). |
| `packages/observability` | Shared telemetry helpers (incl. the secret scrubber). |

`packages/dev` (the Tauri desktop app) was **deleted on 2026-08-23** — desktop is not a product any more, and the CLI runner is the only device agent. `packages/web` is retired (empty — web-v2 replaced it) and `nexus` is gone from `pnpm-workspace.yaml`; none of the three has tracked files, so a local `packages/web/`, `packages/dev/` or `nexus/` is leftover build/`node_modules` residue and safe to delete.

## Key patterns

- TypeScript everywhere (Rust only for the runner)
- All UI clients share the same `core` Hono REST contract (mirrored in `packages/contracts`)
- React Query for server state
- Real-time: WebSocket broadcasts from `core` (`/ws`) to all UIs
- core domain modules: `routes.ts` + service/helper files + co-located `*.test.ts`; web feature modules: `api.ts`, `types.ts`, `components/`, `hooks/`
- Bearer token in Authorization header; web always uses `apiClient` (`src/lib/api/client.ts`), never raw `fetch`
- DB is source of truth: enums/tables live in `packages/core/src/db/schema.ts`; change via `pnpm db:generate` + `pnpm db:migrate` (drizzle-kit)

## Comments & CodeMap (`codemap/1`)

This repo **owns its checker**: `.forge/codemap/cm` is vendored (codemap 0.12.0) and is the
authority — it wins over a `cm` on PATH, which wins over the plugin's bundled copy. Config:
`.forge/codemap.json` (flow vocabulary + enforcement scope) · `.forge/codemap-baseline.json`
(12,558 legacy comments across 986 files frozen by CONTENT — a comment is flagged only when its
text is new, so a reflow or a move is not a violation). **Gate**: the `codemap` job in
`.github/workflows/ci.yml` sits in `ci-passed`'s `needs` list, so a violation blocks the merge. It
runs the prose tier scoped to the PR's changed lines (`--since $(git merge-base origin/main HEAD)`)
plus the referential and structural tiers whole-tree — the second part is load-bearing: a scoped run
attributes a dangling `cm:edge` to the annotated file and drops it when that file is outside the
diff. Bump the checker with `cm install --upgrade`; `.github/workflows/codemap-upgrade.yml` opens
that PR weekly, and `cm doctor` shows any skew. Post-baseline prose is at 0, so anything the gate
reports is something you just added. Spec: `.forge/codemap/SPEC.md`.

**Rule: if a tool can derive it, don't write it.** No `// Load the config` — the compiler already
says that. No new `TODO`/`FIXME`: fix it in the change you are already making and declare it under
`Extra fixes:`; a defect you genuinely cannot fix here goes in the issue comment, never into the
source and never into a new `draft`. Orientation prose goes in the
**module header** (first comment block, followed by a blank line, ≤20 lines); `/** */` on an
`export` is fine (IDE hover docs).

Record the couplings no tool can see, as one-line annotations on line comments (never inside
`/** */`):

| | |
|---|---|
| `// cm:guard <text>` | invariant whoever edits this must obey — **injected into the agent's context before it edits the file** |
| `// cm:edge <kind> -> <repo/path> — <why>` | coupling nothing links. Kinds: `contract` `ordering` `lockstep` `sideeffect` `naming` `protocol` |
| `// cm:flow <flow>/<step> [after:<step>]` | step of a named runtime flow (declare the flow first: `cm new flow`) |
| `// cm:hack ISS-<n> until:<cond> — <text>` | live workaround with an exit condition |
| `// cm:why <text>` | one-line rationale |

**One line means one line, however long.** `cm fmt` does not join a wrapped annotation — measured
2026-08-25, it normalizes 0 of them — so a continuation `//` line stays prose and the prose tier
flags it. Write the whole rule on the single `//` that carries the `cm:` verb, at 300 characters if
that is what it takes. And an annotation makes you the owner of the comment block it lands in:
delete the legacy restatement glued to it, or the file comes back red on comments you never wrote.

Before changing a file with declared couplings: `cm impact <path>` (declared half) **plus** LSP
references (derivable half) — neither is a substitute for the other. `cm verify` before pushing;
`cm fmt` normalizes. Full verb list: `cm` with no args, or the `codemap` skill.

The lockstep edges on `cascadeCancelChildJobs` are the machine-readable form of the orphan-hygiene
table below — change one, check the other.

### What earns an annotation

An annotation earns its place when **deleting it would let the next editor make a wrong change**.
Nothing validates the text, so this is the only test. Three things make one carry:

1. **The rule AND the consequence.** `a broken rule check must never freeze a legitimate
   transition` is 61 characters and complete — it says what must hold and what breaks otherwise.
   Short is not the problem; a short rule gets a short line.
2. **The mechanism that makes it non-obvious.** In `dispatch-gates.ts`, "write the identifiers
   LITERALLY" only earns its place because the next sentence says *why*: Drizzle renders a column
   reference inside a raw `sql` template unqualified. Without that, it reads as taste.
3. **Evidence, when the rule came from an incident.** A date, a measured number, the `ISS-`.
   `Measured on forge-beta 2026-08-11: 3 journal entries … have no bookkeeping row` can be
   re-checked, and dates it.

What does not earn one, with live examples from this repo: `cm:why issue lookup`,
`cm:why pendingSkillUpdates`, `cm:why shipped once`. Those are labels, not reasons — the compiler
already names the code. **Under ~30 characters, an annotation is almost always deletable.**

Pick by consumer, not by taste. `cm:guard` is **injected into the agent's context before it edits
the file**; `cm:edge` drives `cm impact`; **`cm:why` has no consumer at all** — nothing reads it,
not even `cm impact`. So anything a future editor must *obey* belongs in `cm:guard`, never
`cm:why`. Filler accumulates in `cm:why` precisely because nothing surfaces it.

## Ten gates, five axes

Each sits in `ci-passed`'s `needs` **and** is named in its result loop, so a violation blocks the
merge. **That, not this file, is why they hold.** Both halves are load-bearing: `ci-passed` runs
`if: always()`, so a job listed in `needs` but absent from the loop completes, is ignored, and
cannot fail the gate. `archmap` was in exactly that state — measured 2026-08-13, listed here as the
relations gate the whole time it could not block anything. `verify --ci-parity` now fails on the
mismatch, which is why this sentence can be trusted. Every gate that drifted did so while documented and non-blocking — biome to 366 errors,
`typecheck` to 84, and the two length rules to 143 — and each stopped drifting the day it was
baselined and gated (see the comments on the `core` job in `.github/workflows/ci.yml`).

Ten gates over five axes: `form` is gated four times (biome for `core`'s rules, `check-size-budget`
for the length baseline biome cannot hold, `check-lint-budget` for every biome rule set to `warn` in
`core` and `web-v2`, which both had the same error-or-nothing choice, and a bare `biome check
scripts` for the checkers themselves) and `behaviour` three times
(`check-test-reachability` for whether a test file runs at all, `check-test-signal` for whether it
asserts anything, `check-flow-coverage` for whether the flows are walked). **An axis measures at its weakest gate** — reporting the strongest would let one locked
checker hide a sibling that stopped blocking, which is the whole failure mode here.

All ten run from one command: **`pnpm verify`**. A step in `ci.yml` that `verify` neither runs nor
declares fails `verify --ci-parity`, which is itself a CI step — so the local command and the
workflow cannot drift apart.

`.forge/conformance.json` declares each axis's level — `0` no checker · `1` measures, does not block
· `2` baseline the old, block the new · `3` zero violations. `conformance-status.mjs` **runs** every
checker and fails when what it does disagrees with what the manifest claims, so this table cannot
become the next thing that describes a gate it no longer has. Today: form 2 · knowledge 2 ·
relations 2 · behaviour 2 · language 3. Level 2 is the claim *"old debt frozen, new debt blocked"*,
so each such axis must also name where its debt is frozen and which direction improves it —
`baseline: {path, keyBy, improves}`, where `improves` is `down` (a per-key number may only fall),
`shrink` (a set may only lose members) or `tighten` (a status may only get stricter). The direction
lives in the manifest, not in the baseline file, because `--update-baseline` rewrites those files
and a rule a re-freeze can silently drop is not a rule.

**Level 1 is forbidden, and three rules say so rather than this paragraph.** A check that runs,
prints, and blocks nothing has no baseline to be held to, and every gate this repo lost was at
level 1 while documented as blocking — so a check you cannot pass on the day you add it gets frozen
at level 2 that same day, never merged at level 1 with a comment promising cleanup. Each rule below
is a build that goes red, not a number:

- **R8** fails on any CI step carrying `continue-on-error: true` — level 1 written in YAML. Zero
  across `.github/workflows/` since the desktop job was deleted, which is what made freezing it free.
- **R9** fails on any biome rule set to `warn`, `info` or `on` that no baselined checker counts.
  biome exits 0 on a warning and on an info (measured in `core`: *"Found 409 warnings. Found 10
  infos."*, status 0), and `on` means the rule's *default* severity, which is often one of those — so
  all three count, and only `off` and `error` do not. `packages/core` carried 280 uncounted
  diagnostics through a `hardened` profile with ten gates over it, invisible to every audit rule that
  judges a *declared* axis. R9 reads the configs, so a rule left non-blocking by preset default with
  no entry at all is caught only where a lint-budget scope already measures it.
- **R10** fails on any axis that does not declare a numeric level of 2 or more. R1–R9 all skip an
  axis that is not level 2, and `hardened` needs 4 of 5 axes at ≥ 2, so before R10 an axis could
  declare 1 — or omit the key, or quote the digit past `lvl()`'s coercing comparison — and pass the
  whole audit while this paragraph said it could not.

A `down` baseline's totals are compared **per area** (a key's first two path segments), one total
each, and only over areas the base revision already had. Registering a new scope on an existing
checker therefore freezes that scope's debt on arrival instead of being rejected for raising a global
total. Two properties matter: debt on a *new file inside an already-covered area* raises that area's
total and fails, and debt *moved between two covered areas* fails too — which one global sum allowed.
The declared cost is that a re-freeze moving a debt-carrying file into a first-time-seen area escapes
its old area's total; from the baseline alone that edit and a genuine new scope are the same thing.
A test in `scripts/lib/baseline-ratchet.test.mjs` pins it so it stays declared rather than rediscovered.

The manifest also declares a `profile` — the shape the whole repo claims, never the tools it uses:
`baseline` one axis measures · `standard` two axes block and both meta-checks are present ·
`hardened` every declared axis blocks and every `ci-passed` needs-job is asserted. Today: hardened.
`conformance-audit.mjs` is the only check whose subject is the **setup** rather than the code, and
it exists because the protocol is otherwise content-free — a repo could gate nothing, declare a
profile, and be perfectly conformant. Its ten rules and what each was born from: `scripts/README.md`.

| Axis | Gate | Owns | Must not touch |
|---|---|---|---|
| format + lint | `biome check` — job `core` | whitespace, import order, recommended rules | comment content |
| size | `check-size-budget` — job `conformance` | file & function length, frozen per file | which rules exist — biome declares them |
| lint debt | `check-lint-budget` — job `conformance` | per (file, rule) biome violations in `core` + `web-v2`, frozen; drained on touch where a scope asks for it | which rules exist — each package's `biome.json` declares them |
| checkers | `biome check scripts` — job `conformance` | the ten files in `scripts/` that implement every other gate | anything under `packages/` — those have their own configs |
| knowledge | `cm verify` — job `codemap` | `cm:` couplings, prose discipline, module headers | anything a tool can derive |
| relations | `archmap check` — job `archmap` | which module may depend on which | how a file is written |
| reachability | `check-test-reachability` — job `conformance` | whether every tracked test file is collected by a runner, and whether a skipped suite says why | what a test asserts once it runs |
| behaviour | `check-test-signal` — job `lang-check` | whether a test asserts behaviour or restates a declaration | how many tests exist, coverage % |
| flows | `check-flow-coverage` — job `core-integration` | whether every declared `cm:flow` step is executed end-to-end | which flows exist — codemap declares them |
| language | `check-source-language` — job `lang-check` | English-only source policy | everything else |

The reachability row is prior to the behaviour one and that order is the point: `check-test-signal`
scopes itself to what a runner collects, so it measured 493 files while `packages/tests` held 64 that
no runner collected — a checker cannot see what it is not given. Frozen at zero on 2026-08-25, the
one day it cost nothing: 495 tracked test files, 495 collected. Declared skips live in
`.forge/test-skips.json` with a reason each, because *"waiting on ISS-214's endpoints"* is what the
device-runner E2E said for months after those endpoints shipped.

The flows row is the only place the two axes meet. codemap says *which line is step 4 of the
dispatch flow*; the integration suite's v8 report says *which lines ran*. A step named in the map
and executed by nothing is a step the next editor believes is defended. **A step reached only by
unit tests does not count** — with 974 `vi.mock` calls in `packages/core`, a unit test can run a
step's function with every neighbour stubbed, which proves the function runs, not that the flow
connects. Nothing is self-reported: a `// covers dispatch/tick` comment in a test file would be the
claim-instead-of-measurement the manifest exists to catch. All 6 steps of `dispatch` are settled
end-to-end today and `.forge/flow-coverage-baseline.json` freezes one uncovered step,
`release/deploy`; freeze into it with
`--update-baseline` so declaring a new flow is never punished, only visible.

Lint debt is its own row for the same reason, and it now covers two packages. `web-v2` had no biome
config at all until 2026-08-23; measured on the day it got one, 748 diagnostics — 409 formatter, 185
import order, 151 real lint errors. Turning the linter on as `error` would have been 151 red builds
and turning it on as `warn` would have held nothing, so `check-lint-budget.mjs` freezes each
violation per (file, rule) in `.forge/lint-baseline.json` and fails only on growth. Frozen per rule
rather than per line, so moving code inside a file is not a violation. The formatter stays **off**
there on purpose: enabling it is a 313-file, 22k-line diff that would bury every real change under
it, and it is a separate decision from the linter.

`packages/core` joined it on 2026-08-27 (ISS-833) with 280 diagnostics that nothing counted, and
that registration is the whole argument for one shared ratchet: a scope entry in
`.forge/conformance.json` plus one `--update-baseline` run, no second script and no second baseline
file. **487 violations across 175 files frozen on 2026-08-27 — web-v2 210 of an `original` 226, core
277 of 280** — and that `original` map is immutable, because a denominator `--update-baseline` recomputes
makes every percentage relative to the last re-freeze and can never fall.

Core's scope additionally declares `drain`, which is the half freezing does not do: **touch a file
under `packages/core/src` that is not a test, and its count must come back strictly lower.** Equal
is a failure. Freezing alone does not reduce — the codemap baseline sat frozen for months at 3%
drained — and one diagnostic per PR clears core's remaining 53 drainable diagnostics across 32 files
in weeks with no cleanup project. Pay it by restructuring so the compiler narrows
(`issues/pipeline-health.ts` hoists a ternary that `!` had propped up and narrows with `&&`, losing
two assertions with no behaviour change) or with a `// biome-ignore <rule>: <the invariant>` that
states why the assertion holds. Test files and `web-v2` are freeze-only and are never asked to pay:
`rows[0]!` in a test is idiomatic, and a wrong one is a test failure rather than a production crash.
Drain needs a branch delta, so a push straight to `main` runs freeze-only and **prints that it
skipped** — an unprinted skip reads exactly like a pass.

**Never `biome check --write` these rules.** It rewrites `a!.b` to `a?.b`, converting "throw when
the invariant is violated" into "silently evaluate to undefined" — VISION №10 backwards, and the one
change that improves the number while making the codebase worse.

A scope whose baseline freezes debt and which measures **zero** exits 2 rather than reporting clean.
Four review rounds each found a different config that empties the checker's input while biome still
exits 0 — `linter.enabled`, the same switch behind `extends`, an `overrides` block, a narrowed
`files.includes` — so the gate measures rather than enumerates: it does not matter which line did it.
Draining a scope to zero is real and stays recordable with
`--update-baseline --accept-emptied-scope`; what it may never be is silent, because a silent one
deletes the frozen debt and `improves: down` accepts it, faulting only on a rise.

Size is its own row because biome **declares** the two length rules but cannot gate them: it has no
baseline, so the only choices were `warn` (143 violations, `biome check` exits 0, nothing held) and
`error` (143 violations, every build red). `check-size-budget.mjs` reads biome's own JSON, freezes
today's 103 offenders per file, and fails only on growth. It adds no rule — `packages/core/biome.json`
still owns the thresholds. This row is why the format row no longer claims file & function length:
for most of this repo's life that claim was false.

`packages/core/biome.json` carries one `overrides` block, scoped to `**/*.test.ts` and
`**/tests/**`: `correctness/noUnsafeOptionalChaining` drops to `warn` (41 sites) and
`suspicious/noThenProperty` goes `off`. The first is the `expect(call).toBeDefined()` then
`call?.[1]` idiom, where the optional chain is asserted safe one line above; the second is Drizzle's
thenable query builder. Both are downgrades of rules the preset makes errors, so they belong in this
accounting rather than only in the config — an undocumented severity downgrade is how an axis stops
meaning what its row says. Measured 2026-08-25. The `warn` half is now counted by
`check-lint-budget` and audit rule R9 fails if a future downgrade is not: a severity dropped to
`warn` with nothing freezing it is a rule switched off in everything but the config file.

Do not add a rule to one axis that another already owns:

- **No ESLint.** biome ≥ 2 covers `noExcessiveLinesPerFunction` and `noExcessiveLinesPerFile`, which
  is the whole reason ESLint would have been added. A second linter on the same axis means two
  configs drifting apart.
- **No comment rules outside codemap.** A density or run-length rule contradicts it outright: the
  19-line `/** */` block on `failReconcileRunIfNoVerdictRecorded` is documentation codemap exempts
  by form, and 19 comment lines to a counter.
- **No `biome.json` comments.** A comment inside it makes biome **silently ignore the whole
  enclosing block** — no config error, the `overrides` just stop applying. Put the reasoning in the
  commit message.

`.arch.json` declares each contract `draft` or `locked`; `archmap lock <id>` (0.1.4) freezes that
contract's current violations into `.arch.baseline.json`, which is what lets a rule with existing
debt block the *next* violation instead of waiting for someone to fix all of them first. The last
`draft` contract, `no-coordinator-blob`, locked that way on 2026-08-25 with 13 frozen — so every
declared contract now blocks. That file is declared in `conformance.json` under `improves: down`,
because without a direction `archmap lock` is an amnesty button: the ratchet fails a re-freeze that
adds a file or lets a frozen blob grow, and allows one that shrinks.

`archmap check` exit codes: `0` clean · `1` a new violation · `2` **the gate could not run** (bad flag,
unreadable manifest, a scope matching no files). Never read `2` as a pass — the same 1-vs-2 split
`cm verify` uses.

`.arch.json` declares `tsConfig: .arch-tsconfig.json`, and that line is load-bearing: dependency-cruiser
runs with `--no-config`, so without it nothing resolves through a tsconfig `paths` alias — and an
unresolvable edge is **dropped, not reported**. Measured 2026-08-23: 841 of 997 unresolvable edges
were `web-v2`'s `@/*`, i.e. effectively that whole package's graph, while three contracts over it sat
`locked` and passed on nothing. With the map: 5,206 edges resolved, 170 unresolvable of 5,376 possible (3.2%) — all of them
node_modules subpath exports, which belong to no module. Audit rule R7 holds the ceiling, because
`.forge/archmap/` is vendored and a re-vendor could drop the support without a single test going red.

Thresholds live in one place per axis. `.arch.json` declares the architecture (modules by path glob,
plus `layers` / `forbidden` / `independence` / `fan-out` contracts, each `draft` or `locked`); the
file and function line limits live in `packages/core/biome.json`. Locking a contract means **no new
violations**, not zero violations.

### There is no "already red"

Three axes, not three checks — `ci-passed` also needs `core`, `core-integration`, `install-check`,
`lang-check`, `runner`, `docs`, `web`. The one that stayed red longest was an unnamed one.

**A defect you have seen may not leave your hands labelled "not mine".** In reach and inside the
ownership line (no merging or reverting a shared branch, no doing another issue's work, no silently
overriding a human's decision) → **fix it**, whoever caused it and whether or not it is in your AC.
Out of reach → it leaves as someone's work: a `blocks` edge, a `docs/proposals/` line, or a comment
with evidence (`waiting` + `reason` when it blocks this issue). **Never a new issue** — filing a
fixable defect instead of fixing it is the `file-instead-of-fix` red flag, and it is what put 30
unread drafts on forge-dev by 2026-08-18.

"Pre-existing", "untouched", "out of scope" are reasons to **record**, never reasons to go quiet.
Measured 2026-08-13: five `forge-test` runs wrote *"lint remains red only on pre-existing, untouched
diagnostics"* and merged — `core` is a required check. `core-integration` was red on 5 tests at the
same time, one of them ISS-812's own regression suite, which had never run anywhere: code wrote it
without running it, review approved it, test could not run it, all three disclosed honestly and
moved on. Nobody lied and nobody fixed it. "Already red" only means earlier steps dodged too.

**`.forge/` is committed, all of it.** Both checkers are vendored there (`.forge/codemap/`,
`.forge/archmap/`) and the CI jobs run those copies, so a contributor without a global install and
the gate are held to the same reviewed version — bump with `cm install --upgrade` / `archmap install
--force` and commit the result. The registry, both baselines, and `orientation.md` (which this file
imports on its first line) live there too. `.forge/.gitignore` is the only place an exception may be
declared, and it carries the reason; a blanket `.forge/` in `.git/info/exclude` is a **local** rule
teammates never see, and it is why `orientation.md` went uncommitted for months.

Both vendored shims must stay mode `100755` — `git ls-files -s .forge/*/[ac]*` to check. A shim
committed `100644` fails the job with permission denied, not with a violation.

## Commands

**`pnpm verify` when you finish coding, before you push** — the conformance entrypoint. It runs
every check CI runs, reports all of them in one pass instead of stopping at the first, and prints
the `cm:guard` / `cm:edge` / `cm:flow` declared on the files you touched. Exit `0` clean · `1`
violations · `2` a check could not run. This is the mechanism; hooks only make it arrive sooner, and
a contributor with no plugin installed is held to exactly the same bar. Details and how to add a
check: `scripts/README.md`.

`verify --ci-parity` is itself a CI step: a `- run:` in `ci.yml` that `verify` neither runs nor
declares in `CI_COVERAGE` fails the build. That is what stops the local command and the workflow
drifting apart, which would make a green `pnpm verify` meaningless.

From the repo root, turbo fans out: `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` / `pnpm lint`. Per package (from inside `packages/<pkg>/`):

| Package | Dev | Build | Test | Lint |
|---------|-----|-------|------|------|
| core | `pnpm dev` (tsx watch) | `pnpm build` (tsc) | `pnpm test` (vitest); `pnpm test:integration` | `pnpm lint` (biome) |
| web-v2 | `pnpm dev` (next, :3100) | `pnpm build` | `pnpm test` (vitest) | `pnpm lint` (`check-lint-budget`, not biome directly) |
| runner | — | `cargo build` (in `packages/runner`) | `cargo test` | — |

DB (in `packages/core`): `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:studio` (drizzle-kit).


## Observability — Sentry (opt-in)

**OSS contract**: every Sentry init reads its DSN from env at build/run time. Source builds without those env vars compile cleanly with the SDK no-op'd — cloning and building never silently reports anywhere. Only official release artifacts bake DSNs (via CI secrets); self-hosted operators opt in by setting the env var in their own deploy environment.

| Service | Init location | Enable via |
|---------|---------------|-----------|
| backend (Hono) | `packages/core/src/observability/sentry.ts` | runtime `SENTRY_DSN` |
| cloud UI (Next.js) | `packages/web-v2/src/providers/sentry-init.tsx` | build-time `NEXT_PUBLIC_SENTRY_DSN` |

All payloads pass through a scrubber that replaces Authorization, X-Device-Token, Cookie, X-API-Key headers; `authToken`/`auth_token`/`jwt`/`apiKey`/`api_key`/`password`/`token` body fields; and tokenized URL query params with `[Filtered]`.

## Orphan job hygiene

**INVARIANT: no child `jobs` row stays non-terminal under a terminal `pipeline_run`.** (One orphan wedges a cap=1 runner slot.) Three defences, keep in lockstep:

| # | Defence | Where | Fires on |
|---|---------|-------|----------|
| 1 | Cascade on close — ALL terminal transitions route through `cascadeCancelChildJobs` | `packages/core/src/pipeline/runs-cascade.ts`; callers: `closeRun`, `closeRunIfOneShot`, `closeOpenRunForIssue` (`runs.ts`), `cancelPipelineRun` (`runs-control.ts`) | run goes terminal |
| 2 | Loop monitor — the primary reaper: `runLoopMonitor` / `reapAckMisses` / `reapResultMisses`, quiet threshold `RESULT_QUIET_MINUTES = 60` (don't lower — legit merges run long). Sweeper passes are demoted to alarm-only, except session-lost propagation `reapSessionLostJobs`. | `packages/core/src/jobs/loop-monitor.ts` · `packages/core/src/pipeline/sweeper.ts` | never claimed / gone quiet / dead session |
| 3 | Dispatch gates require `pr.status IN ('running','paused')` so terminal-parent orphans never count toward the runner cap | `packages/core/src/jobs/dispatch-gates.ts` (`countInFlightForRunner`, `checkLayer4RunnerFull`, `runner_load` CTE) | every dispatch |

- Cascade effects: jobs → `cancelled` (`failureKind='transient'`, `failureReason='pipeline_*'`); linked `agent_sessions` → `failed`; broadcasts `agent:abort`.
- New code that flips `pipeline_runs.status` terminal MUST route through a cascade-calling helper — no second mechanism cleans up after you.
- **`held` is a fourth, deliberate shape and is NOT an orphan** (RFC 0002). A `held` job is alive and non-terminal *under a run that is also non-terminal* — the invariant above still holds, because INV-4 forbids closing a run while any of its jobs is held. It is excluded from defence 3's `runner_load` and from the project serial gate (`running_ids`), so it burns no slot, and defence 2 never reaps it. It IS counted by L1 `issueBusyJob`, so no duplicate job is enqueued for the same issue. Do not "clean up" a held job: `jobs/hold.ts` `releaseHeldJobs` re-queues the two condition-checked reasons and the other three wait for a human on purpose.

## Pipeline-step analytics

The `pipeline_run_step_durations` SQL view (created in migration `0055`, reshaped by `0057` and `0128`) exposes **one row per finished job** (all terminal statuses):

| column | source |
|---|---|
| `run_id`, `project_id`, `issue_id` | `pipeline_runs` (issue_id is NULL for kind `pm`/`interactive`/`system`) |
| `step` | `jobs.type` (`triage`, `clarify`, `plan`, `code`, `review`, `test`, `release`, `fix`, `custom`, `pm`) |
| `started_at` | `COALESCE(agent_sessions.started_at, jobs.dispatched_at)` |
| `finished_at` | `jobs.finished_at` |
| `duration_seconds` | NULL unless the job is `done` — aggregate with `count(duration_seconds)`, not `count(*)` |
| `cost_usd` | sum of `usage_records.estimated_cost` for the job's `agent_session_id` (all statuses) |

REST surface: `GET /api/pipeline/step-durations?projectId=&days=&step=` (one JSON row per view row, camelCase keys).

Grafana starter (query the view, not raw tables):

```sql
SELECT step, percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_seconds) AS p95_s
FROM pipeline_run_step_durations
WHERE started_at >= now() - interval '7 days' AND duration_seconds IS NOT NULL
GROUP BY step ORDER BY p95_s DESC;
```

## Recipes

- **New core endpoint** → route module `packages/core/src/<domain>/routes.ts` (Hono + Drizzle) + mount in `src/index.ts`
- **New MCP tool** → `packages/core/src/mcp/tools/forge-<name>.ts`
- **New web feature** → `packages/web-v2/src/features/<name>/` with `api.ts` + `types.ts` + `hooks/` + `components/`
- **Schema change** → `packages/core/src/db/schema.ts` → `pnpm db:generate` + `pnpm db:migrate` → propagate to `packages/contracts` → web/dev TS types → MCP tool descriptions

> ⚠️ **A migration's `when` in `drizzle/migrations/meta/_journal.json` must exceed EVERY `created_at` already recorded in the target database — not just the previous entry's.** drizzle reads the single highest `created_at` once, before the loop, and applies only entries above it; per-hash presence is never checked. An entry at or below that watermark is skipped **silently, forever** — `migrate()` still reports success, so the container starts and serves new code against an old schema. This is not hypothetical: it put a live 500 on `GET /me/attention` for every signed-in user (ISS-807), because two hand-authored entries used real `Date.now()` values that were lower than a predecessor whose `when` had drifted into the future under this repo's `prev + 86400000` convention.
>
> Follow the convention — take `max(when)` across the journal and add `86400000` — rather than a real timestamp. `pnpm test` fails on a non-monotonic entry (`db/migrations-journal.test.ts`), and `db/migrate.js` prints a warning at startup naming any journal entry with no ledger row.
