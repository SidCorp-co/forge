# Trigger functions resolve their tables through the caller

Six of this repo's PL/pgSQL functions read a table by bare name. PL/pgSQL resolves an unqualified
name against the **invoking session's** `search_path` at execution time, and `pg_temp` is searched
ahead of `public` without appearing in the setting. A session holding a temporary table of the same
name therefore substitutes its own relation for the real one, and the function reads it instead.

**Status:** open. One instance is fixed — `issue_prefix_aliases_immutable` (ISS-992, migration
`0238`), which qualifies its lookup to `public.projects` and pins the function's own `search_path`.
The other six are untouched. Found by a codex review of the landed ISS-992 head on 2026-09-13; the
population was measured by the forge-dev resident master and the exposure below by the ISS-992 run.

## Why this is not theoretical

Demonstrated against Postgres 16 on 2026-09-13, on a probe table reproducing the prefix guard:

| step | result |
|---|---|
| hand-written tombstone, no shadow | refused, as designed |
| same write, with an empty `CREATE TEMP TABLE projects` in scope | **succeeded** |
| the row afterwards | `project_id IS NULL` — the alias orphaned |
| `SHOW search_path` throughout | `"$user", public` |

The last row is what makes this worth a document. The subversion does not appear in the session's
own `search_path`, so a guard that reads correctly in every review can be switched off by the
caller, and nothing in the setting says so.

The reverse direction is the same defect: a session that cannot resolve the name at all — a restore
running with a narrowed `search_path` — fails the lookup and blocks a legitimate write.

## The exposure, measured

Ten distinct functions exist across `packages/core/drizzle/migrations`, counted by their **latest**
`CREATE OR REPLACE` rather than per file. None of the fourteen files defining them contains
`SET search_path` except `0238`.

| function | latest definition | reads by bare name |
|---|---|---|
| `assign_issue_iss_seq` | `0004_issues_phase23_f1.sql` | `project_iss_counters` |
| `enforce_comment_depth` | `0026_comment_depth_drop_dead_cycle_guard.sql` | `comments` |
| `pipeline_outbox_on_status_change` | `0070_pipeline_outbox.sql` | `pipeline_outbox` |
| `enforce_no_active_child_under_terminal_run` | `0180_i1_trigger_failure_kind_regression.sql` | `pipeline_runs`, `kernel_transitions` |
| `forge_record_memory_replacement` | `0208_memory_revisions.sql` | `memory_revisions` |
| `forge_unaudited_issue_id` | `0219_unaudited_transition_reach.sql` | `pipeline_runs` |

Not exposed, and worth recording so the next reader does not re-check them:
`forge_detect_unaudited_transition` and `forge_detect_unaudited_deletion` build their target as
`%I.unaudited_transitions` from the trigger's own schema, which is already qualified;
`forge_identifier_words` reads no relation.

Two of the six sit on invariants this repo names as load-bearing:
`enforce_no_active_child_under_terminal_run` is a defence of the forward half of the
`pipeline_run`/`jobs` terminal invariant, and `enforce_comment_depth` is what makes a fixed number
of comment-tree rounds complete rather than a guess.

## Why it is a document and not a diff

Each fix is small — qualify the relation, pin the function's `search_path` — but the set is a
hardening sweep across the kernel's triggers, and two of them guard invariants whose semantics the
ISS-992 run did not study. Six kernel trigger functions rewritten inside a change about issue
reference prefixes is a diff nobody asked to review in that context, and the failure mode of
getting one wrong is an invariant that stops holding rather than a test going red. It wants its own
change, its own reviewer, and a regression case per function of the shape ISS-992 used: assert the
guard still refuses with a shadow relation in scope.

The decision that is not the ISS-992 run's to make: whether pinning `search_path` becomes a rule
for every function this repo defines from here, enforced by a gate over
`drizzle/migrations/*.sql`, or whether the six are fixed case by case and the pattern left to
review. A gate is the only form that stops the seventh arriving.

## Honest costs

The price of adopting the fix, not of the defect it closes.

| Cost | What it takes |
|---|---|
| One migration replaces six live guards at once | Each is a `CREATE OR REPLACE` against a function the database is already enforcing. A mistake in one is not a red test but an invariant that quietly stops holding — and two of the six are defences of the `pipeline_run`/`jobs` terminal invariant and the comment-depth bound. |
| `SET search_path` blinds the function to temporary tables | That is the point, and it is not free: any function that legitimately resolves a relation through the caller — a dynamic `%I` target, a session-scoped staging table — breaks when pinned. Each of the six must be read for that before it is pinned, which is the work, not the one-line edit. |
| A per-call GUC save and restore | `SET` on a function costs a context save on every invocation. `pipeline_outbox_on_status_change` fires on every issue status change and `enforce_comment_depth` on every comment write, so the overhead lands on the hottest paths rather than the rare ones. Unmeasured here; whoever adopts this should measure rather than assume it is noise. |
| Six regression cases, each needing a real Postgres | The only test that proves the fix is one that creates a shadow relation and asserts the guard still refuses. That is an integration case per function, on the suite that is already the slowest thing CI runs. |
| The history keeps the wrong pattern | The fix is a new migration; the fourteen existing files still show the unqualified form, so the next author greps history and copies it. This is the cost a gate removes and case-by-case fixes do not. |
| A gate over `drizzle/migrations/*.sql` taxes every future migration | It must permit the dynamically-qualified `%I` form and functions that read no relation, or it refuses correct code — and a gate with a wrong refusal is worse than none, because the way around it is a waiver nobody revisits. |
