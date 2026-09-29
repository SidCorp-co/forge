# The verify window: several green changes, one validation, one landing each

`scripts/verify-window.mjs` takes a set of pull requests that are each already green at their own
head, validates them together once, and lands every one of them as its own merge commit. It is the
mechanism the `forge-integrator` role drives; it builds, attributes and plans, and it pushes, opens
and merges nothing — landing stays the dispatcher's act.

## Why it exists

Branch protection on `main` is `strict: true` with `ci-passed` required. Landing one pull request
puts every other open one behind, and each of those then pays an update, a fresh review read at the
new head and a whole CI run: about N²/2 cycles for N changes (ISS-1203 measured five PRs on
2026-09-22, every one after the first brought up to date at least once). The window pays the gate
once for the set.

## The flow

The integrator writes a manifest outside the checkout: the window id, the base branch, the
thresholds with where they were read, and the members in landing order, each with its issue,
branch, head, arrival time and priority.

1. **`admit`** — each member's branch still points at the recorded head, its required check is a
   success at that head, its head is not already on the base, and its diff touches no ineligible
   surface. The declarations are read from `.forge/verify-queue.json` **at the base commit**, so a
   member cannot loosen the rule it is judged by.
2. **`fire`** — the count, the oldest member's wait measured from its recorded arrival, or a
   critical member. A manifest declaring no thresholds is refused; there is no default.
3. **`assemble`** — a worktree at the base commit, and one `git merge --no-ff` per member in order.
   What the repository orders across branches is re-derived as each member enters (below). A
   path the declarations name as a union — `CHANGELOG.md`, where every pull request adds its entry
   at the same place — takes the member's added lines beside the combination's, each after the
   base line it follows; a member that removed or rewrote a line there is isolated instead, since
   keeping both versions would publish the old entry beside the new one. A member conflicting on
   any other path is isolated with the path and the earlier member that changed it named; the
   members after it still enter. The ledger is written beside the manifest
   as JSON and as the markdown each member's issue carries.
4. **One pull request** of the chain head into the base. Its `ci-passed`, with its full needs list,
   is the one validation.
5. **`attribute`** — a refusal naming a path belongs to the last landing that changed it. One naming
   no path is replayed with `--unit "<command>"` on the base alone and on each member alone: a
   failure on the base is pre-existing, on exactly one member alone is that member's, on no member
   alone but on the combination is an interaction, and anything else names no owner.
6. **`isolate --member <ISS> --because "<the checker's words>"`** — rebuild without that member,
   recording why, then push the new chain head to the same pull request.
7. **`land`** — refused where the base or a landed member's branch moved since assembly, where the
   required check at the chain head is not a success, or where a member's reviewed head is not an
   ancestor of its landing. Otherwise it prints each landing beside its reviewed head and the merge:
   `gh pr merge chore/verify-window-<id> --merge`. Never squash and never rebase it: the point of the
   chain is that a revert (`git revert -m 1 <landing>`) still names one change.

## How it composes with `ci.yml`

Nothing in `.github/workflows/ci.yml` changes. The window's pull request is an ordinary
`pull_request` run, so every job its paths select runs and `ci-passed` gates it as any other. Its
merge commit's push to `main` has two parents, and the changes job's step *Whether a pull_request
run already proved this exact tree* sets `proved=true` for exactly that shape, so `core`,
`core-integration`, `web`, `runner`, `images` and `whole-tree` are not paid again. The always-on
cheap jobs still run on that push.

## Migrations

Two branches deriving `+86400000` from one `main` land on the same `when`, and drizzle skips the
lower one silently and for ever (ISS-807). As each member enters, its new journal entries keep their
numbers only where the first clears the base, the combination so far and every open branch outside
the window — `checkSet`'s `next` in `scripts/lib/migration-order.mjs`, the number
`check-migration-order.mjs` prints as `Next free:`, read through the same `readOpenSet`. Otherwise
they take consecutive numbers from it, their `.sql` and snapshot files are renamed, and every other
file naming the old tag is rewritten; the ledger lists each renumbering and each rewritten file.

`packages/core/drizzle/migrations/README.md` tells a developer to regenerate a snapshot on the
merged tree rather than renumber by hand. The window renumbers by tool, and rebases a member's
snapshot onto the combination's head snapshot object by object: two members adding different
tables, or different columns to one table, compose. A member is isolated, with the object named,
where it and an earlier member both touch one table, enum, view, sequence, role, policy or schema
and either removes or changes what was in it — an index added by one and its column dropped by the
other is the case — or where one points (a foreign key's `tableTo`, an enum-typed column) at an
object the other removed or changed. That member's repair is the regeneration the README describes,
in its own run.

## What a member must not be

A change whose defects are green on its own run and red only under the whole gate — process-wide
state, the environment or `PATH`, concurrency and ordering, a platform its run does not execute
on — is not admitted and takes the whole gate in its own run. `.forge/verify-queue.json` declares
those surfaces as path globs and as patterns over added lines, each with its reason. When the shared
gate refuses over one anyway, the surface belongs in that file.

## What it does not do

- It does not choose which checks a developer run may skip. That split — an entry layer each run
  pays and a shared layer the window pays — lives in `scripts/verify.mjs` and in the issue-flow
  method's baseline, and is not built here.
- It does not use GitHub's `merge_group`. The native queue validates one entry at a time and does
  not batch.
- It has not been exercised against a live window on this project. That GitHub marks each member's
  pull request merged once its head is reachable from `main` is the platform's documented
  behaviour and is not measured here.
