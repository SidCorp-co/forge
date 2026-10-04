# The verify window: several green changes, one validation, one landing each

`scripts/verify-window.mjs` takes a set of finished branches and validates them together once. Each
branch's own entry gate passed at its head, and none has a pull request of its own. It lands every
one as its own merge commit, through the window's one pull request. It is the mechanism the
`forge-integrator` role drives. It builds, attributes and plans. It pushes, opens and merges
nothing, because landing stays the dispatcher's act.

## Why it exists

Branch protection on `main` requires `ci-passed`, and while it was `strict: true` — until ISS-1370
had the owner turn it off — landing one pull request put every other open one behind, and each of
those then paid an update, a fresh review read at the new head and a whole CI run: about N²/2
cycles for N changes (ISS-1203 measured five PRs on 2026-09-22, every one after the first brought
up to date at least once). The window pays the gate once for the set.

## The flow

The integrator writes a manifest outside the checkout. It holds the window id, the base branch, the
thresholds with where they were read, and the members in landing order. Each member carries its
issue, branch, head, arrival time, priority and entry-gate record. Priority is `critical`, `high`,
`medium` or `low`, and any other value is refused by name rather than read as ordinary. The
entry-gate record is `entry: { at, record }`: the commit its own run's `pnpm verify --entry` passed
at, and where that run recorded it.

A member waits as a pushed branch and opens no pull request (owner ruling, 2026-09-30). A member's own pull request would pay the whole CI once per
member and put the others behind at every landing. So no check ever reports at a member's head, and
its own proof is the entry-gate record. `ci-passed` stays the required check, read at the window's
one pull request.

1. **`admit`**: each member's branch still points at the recorded head, and its entry-gate record
   was taken at that head. A missing record, a missing `record`, or an `at` that is not that full
   commit is refused by name. Its head is not already on the base, and its diff touches no
   ineligible surface. The declarations are read from `.forge/verify-queue.json` **at the base commit**, so a
   member cannot loosen the rule it is judged by. Admission reads no migration numbers, so a branch
   outside the window whose journal cannot be read refuses at `assemble`, where numbers are
   allocated, and never withholds a member's verdict. Every key that would otherwise read as permission
   is required: `gate.prepare` (`[]` where the gate needs no preparation), `ineligible.paths` and
   `ineligible.lines`, so an omission is refused by name rather than read as nothing to prepare or
   nothing ineligible.
2. **`fire`** — `size` members waiting, the oldest member's wait from its recorded arrival reaching
   `minutes`, or a critical member; a window above an optional `maxSize` is refused. These are the
   release train's keys, which this project has not yet set, so
   a manifest declaring none is refused and there is no default. A declared value that is not
   positive, or a `size` or `maxSize` that is not whole, is refused as that value. So is an
   `arrivedAt` later than the time the window is judged at.
3. **`assemble`** — a worktree at the base commit, and one `git merge --no-ff` per member in order.
   A window id whose `chore/verify-window-<id>` branch is already pushed is refused: the window's
   own branch is left out of the open set, and a fresh window cannot tell its own from a stale one.
   What the repository orders across branches is re-derived as each member enters (below). A
   path the declarations name as a union — `CHANGELOG.md`, where every pull request adds its entry
   at the same place — takes the member's added lines beside the combination's, each after the
   base line it follows; a member that removed or rewrote a line there is isolated instead, since
   keeping both versions would publish the old entry beside the new one. The lines are matched by
   Myers' linear-space diff, so a file of any length unions. This repository's `CHANGELOG.md` is
   over 7,000 lines. Where a base line is duplicated, the diff's choice of which copy an addition
   follows can refuse an addition that another choice would keep. It never drops or doubles one.
   A member conflicting on
   any other path is isolated with the path and the earlier member that changed it named; the
   members after it still enter. The ledger is written beside the manifest
   as JSON and as the markdown each member's issue carries.
4. **`validate`** — the `gate` the declarations name, `node scripts/verify.mjs --window`, prepared
   and run once in the window's tree. It pays the shared layer's sweeps that no member's own run
   paid, plus the entry layer again, where two members' edits meet in one file (scoped to the
   combination's diff for a check that declares a scoped form). Its steps, and every replay step 5
   runs, see `GITHUB_BASE_REF` set to the window's base branch, so the gate resolves the target the
   window was built on and not the operator's default. It refuses, and records nothing,
   where the tree is not exactly the chain head before or after preparing: HEAD elsewhere, a tracked
   change, or an untracked file the gate would read as the combination's. The ledger records each
   pass as the window's cost figure: what it took and how many members shared it. Red, it prints
   the gate's own words, which step 5 attributes.
   **One pull request** of the chain head into the base follows, and its `ci-passed`, with its full
   needs list, stays the required check.
5. **`attribute`**: a refusal naming a path belongs to the last landing that changed it, and a
   directory is every path under it. A path given as a checker prints it, relative to a package,
   matches no landing exactly. Where it ends a path a landing changed, those paths are named and no
   owner is guessed (`unresolved`). Each attribution is recorded with its subject and the chain head
   it was measured on. The ledger's markdown marks one carried over an `isolate` as measured on the
   earlier chain. One naming
   no path is replayed with `--unit "<command>"` on the base alone and on each member alone: a
   failure on the base is pre-existing, on exactly one member alone is that member's, on no member
   alone but on the combination is an interaction, and anything else names no owner. A member alone
   is rebuilt from its ledger row on the base the window was built on, with no branch of the window
   counted among the open branches its migrations are numbered against. Every replay tree is
   prepared with the declared `gate.prepare` first, so an unprepared tree never reads as a failure
   on the base; a step that cannot prepare one stops the replay, attributing nothing. A replay that
   exits 2 (a checker that could not run), 126 or 127 (a command the shell could not run) or on a
   signal measured nothing, and names no owner, whichever tree it was in. The combination's tree is
   held to the chain head as `validate` holds it, before and after preparing, so a stray edit there
   is refused rather than replayed as a member's.
6. **`isolate --member <ISS> --because "<the checker's words>"`** — rebuild without that member,
   recording why, in the tree the ledger recorded; a window with no ledger, any other `--tree`, or a
   path there that is no longer a worktree of the repository is refused and nothing is deleted. The
   manifest is rewritten only once the rebuild has succeeded, so a rebuild that fails leaves the
   manifest and ledger as they were, and the next `isolate` rebuilds in the recorded path. A rebuild
   that worked exits 0 when every member it left out was left out by a recorded `isolate`. It exits
   1 only when the rebuild itself refused or isolated one, as `assemble` does, and it lists them.
   The new chain does not descend from the one already pushed, so the push it prints
   replaces the window's branch with a lease on the head it read there, and refuses if anyone moved
   that branch since.
7. **`land`** — refused where the base or a landed member's branch moved since assembly, where the
   window's branch on the remote does not point at the chain head the ledger holds (a rebuild not
   yet pushed), where the required check at that head is not a success, where a member's reviewed
   head is not an ancestor of its landing, or where no member has a landing at all, since a window
   whose every member was refused or isolated has nothing to land. A check that is not a success
   says what comes next. `absent` means nothing has refused yet, so read it once the window's pull
   request has run. A run still in flight is read again once it concludes. `failure` and
   `timed_out` are attributed. Any other conclusion is no verdict and is re-run. The check is
   read from GitHub, or with `--checks <file>` from a file saved from it. An `origin` that is not on
   GitHub is refused, naming `--checks`, rather than asked about as `repos/null`. Otherwise it
   prints each landing beside its reviewed head
   and the merge, pinned to that head:
   `gh pr merge chore/verify-window-<id> --merge --match-head-commit <chain head>`. Never squash and
   never rebase it: the point of the chain is that a revert (`git revert -m 1 <landing>`) still names
   one change.

## How it composes with `ci.yml`

Nothing in `.github/workflows/ci.yml` changes. The window's pull request is an ordinary
`pull_request` run, so every job its paths select runs and `ci-passed` gates it as any other.

Its merge commit's push to `main` is what the changes job's step *Whether a pull_request run
already proved this exact tree* reads (ISS-1340): two parents off the commit object, a tree equal
to the second parent's, and that parent's latest `ci-passed` concluded `success`. `land`'s
`gh pr merge --merge --match-head-commit <chain head>`, on a window branch up to date with the
base, gives all three, so that push skips `core`, `core-integration`, `web`, `runner`, `images`
and `whole-tree`. A merge taken any other way, or past red, re-proves the tree as any push does.

## Migrations

Two branches deriving `+86400000` from one `main` land on the same `when`, and drizzle skips the
lower one silently and for ever (ISS-807). As each member enters, its new journal entries keep their
numbers only where the first clears the base, the combination so far and every open branch outside
the window — `checkSet`'s `next` in `scripts/lib/migration-order.mjs`, the number
`scripts/check-migration-order.mjs` prints as `Next free:`, read through the same `readOpenSet`.
Otherwise they take consecutive numbers from it, their `.sql` and snapshot files are renamed, and
every line the member's merge adds that names an old tag — its own, or one an earlier member was
moved off — is rewritten, all of its tags in one pass, and no line already in the combination is
read again, so a tag moved onto another's old number is never moved twice; the ledger lists each renumbering and each
rewritten file. A member's new entries are the ones missing where it forks from the combination, so
a member stacked on an earlier one does not bring that one's migration back in under the tag it had
before the window renumbered it, and its snapshot is rebased from the parent in its own tree.

`packages/core/drizzle/migrations/README.md` tells a developer to regenerate a snapshot on the
merged tree rather than renumber by hand. The window renumbers by tool, and rebases a member's
snapshot onto the combination's head snapshot object by object: two members adding different
tables, or different columns to one table, compose. A member is isolated, with the object named,
where it and an earlier member both touch one table, enum, view, sequence, role, policy or schema
and either removes or changes what was in it — an index added by one and its column dropped by the
other is the case — where both add one object or one column, identically or not, since two
migrations cannot both create it, or where one points (a foreign key's `tableTo`, an enum-typed column) at an
object the other removed or changed. That member's repair is the regeneration the README describes,
in its own run.

## What a member must not be

A change whose defects are green on its own run and red only under the whole gate — process-wide
state, the environment or `PATH`, concurrency and ordering, a platform its run does not execute
on — is not admitted and takes the whole gate in its own run. `.forge/verify-queue.json` declares
those surfaces as path globs and as patterns over added lines, each with its reason. When the shared
gate refuses over one anyway, the surface belongs in that file.

## What it does not do

- It does not decide which layer a check is in. `scripts/verify.mjs` declares that per check, by
  what the check reads (`scripts/README.md`, *Two layers*): a developer run of a queue-eligible
  change runs `pnpm verify --entry`, and the window runs the rest once. Which command a run's method
  calls is the project's knowledge, not this tool's.
- It does not use GitHub's `merge_group`. The native queue validates one entry at a time and does
  not batch.
- It has been exercised on scratch branches against a scratch remote (ISS-1203), not yet on a live
  window of this project's branches.
