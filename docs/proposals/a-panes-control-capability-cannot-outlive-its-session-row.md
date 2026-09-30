# A pane's control capability cannot outlive the session row it names

**Status:** decided and built. The owner chose **shape 1** on 2026-09-20, on ISS-1099; ISS-1316
built it. A capability now names what its pane was placed to be, so it outlives the session row it
was minted under. What is left on this page is the residuals shape 1 does not close, and what
adopting it cost.

**Why this page exists twice.** An earlier version of it was an open residual — three shapes, a
table of honest costs, and `No fix proposed here` — and it was deleted on 2026-09-20 in the cull
that left `docs/proposals/destination/` standing. The decision that followed it lives in a comment
on ISS-1099, which is an issue that will close. This page is the decision, so that closing it does
not take the promise with it.

## The mechanism

A master pane carries one capability, `FORGE_CONTROL_TOKEN`, minted into its environment at spawn.
A pane cannot be handed a new one: its environment is fixed at exec.

Core's side, `devices/master-session.ts:ensureMasterSession`, reuses a master session row only while
it is non-terminal and reaps one whose heartbeat stops. When the row goes terminal under a
still-running pane, the next registration creates a second row and the daemon adopts the pane onto
it. Until shape 1 the token mapped to the session id alone, so from that moment the pane's own token
named a row the daemon no longer held, and every declaration it made was refused.

Measured on forge-vm on 2026-09-18: one project stood still for four hours, answering 45 nudges with
the same refusal, while five rows waited behind it.

## The decision: shape 1, the capability carries the project

The token store (`daemon/session_tokens.rs`) holds `token -> { session, project, slug, pane }`,
written by `SessionTokens::mint` at placement for a pane the daemon is about to start. The slug is
there for the operator rather than the kernel: nothing resolves authority through it, and a record
forge-runner 0.17.72 wrote carries none. Nothing rewrites an
entry after its mint. `control.rs:caller_of` resolves a frame to that record and to the session it
acts under: the session this daemon now holds for the record's project, where this daemon's master
pane for that project is the record's pane. `control.rs:declaring_project` bounds a declaration by
the record — the declared project must be the record's, and the record's pane must be the project's
live master pane — which is ISS-1050 criterion 7 re-established at the record, and is why a job
pane's capability, which carries a record too, declares nothing.

`master.rs:capability_of` judges a resident pane current where a record names its project and pane,
whatever session core serves it now. On that adoption `Masters::readopt` moves the registry to the
session core serves, and the sweep's `carried_across` re-records under that session the project's
open runs whose recorded Claude Code process still runs beneath the pane's own process
(`subagent_host::Hosts::beneath`), so the pane's `run close` and `run choice` answer for them. The
process's parentage, not the session, is what attributes a run to the pane: core hands the pane
placed next under the same name the same non-terminal row, and a process merely alive is tied to no
pane. A run whose process could not be placed is left where it is and counted.

**Why not shape 2 — re-point the entry on adoption.** It makes a minted capability's meaning
mutable. Under `VISION: kernel-hard-policy-soft` authority is kernel and its tolerance is zero — a
value that looks representable but has been redefined underneath its holder is how state starts
lying, and nothing downstream can detect it. What moves under shape 1 is which session this daemon
serves a pane under; the entry the pane holds says what it said at mint.

**Why not shape 3 — core keeps the row alive on the box's word.** Core would stop being able to reap
a master row on its own evidence, so a box that dies without saying so leaves live master rows that
nothing closes. That is the hole ISS-919 B1 was filed to close, reopened from the other side, and it
runs into this repository's stated invariant that no child row stays non-terminal under a terminal
parent.

**The reversal condition did not hold.** The decision would have reversed if the format change had
required a shape core reads. It does not: core never reads `control-tokens.json`, and
`transport/run_sessions.rs:open` sends no master session id, so the change is local to the box.

## What "complete" means here, and where each part landed

1. **Shape 1 itself**, as above (ISS-1316).
2. **A repair path for a pane already in the broken state.** ISS-1208's recovery is it. A pane that
   holds a capability minted before the record, and whose row core has replaced, still reads
   `stale`; where the sweep would place a replacement, the box ends it and places one carrying a
   record. A pane carrying a record is never ended for its row having been re-minted.
3. **ISS-1050 criterion 7's argument, re-made at the new location** — in
   `control.rs:declaring_project`, and it is the bound the review of ISS-1316 had to re-establish
   rather than assume.

## The two shapes a map can hold

A map written before the record maps a token to a bare session id. The reader
(`SessionTokens::load`) accepts both shapes: a pre-record entry resolves to its session exactly as it
always did, and `SessionTokens::resolve` says so once per session per process, naming it as a
capability minted by forge-runner before 0.17.72 that loses its authority with its row. Refusing those entries would have refused every
live master on every box at the upgrade. A file in neither shape, or with an entry carrying an empty
value, is refused by name — the file, and both valid shapes — and every frame against it is refused
rather than read as an empty map, which is indistinguishable from a box with no panes. The daemon
logs such a failure once, again only when the failure changes, and once when the map reads again:
a pane sends a frame per hook, so a line per frame would bury the journal.

## The declaration gate's hook, which the record now answers for too

The hook is installed per checkout — `hook_install::install` writes
`<cwd>/.claude/settings.local.json` — so it runs in every Claude Code session whose working
directory is a Forge checkout, while only panes the daemon placed carry `FORGE_CONTROL_TOKEN`.
Measured on sid-xeon-1 on 2026-09-24: all 279 marks in `gate-marks.jsonl`, over 90.7 hours, came
from its no-token branch, which could not tell a daemon pane whose capability never arrived from a
session the daemon never placed.

`cmd/gate.rs:tokenless` now tells them apart from the process's own `$TMUX` and the record. Off the
runner's tmux server, the session is not the gate's subject: it is let through and leaves no mark.
On it, the hook asks tmux its session name: a session a record names is a placed pane that lost its
capability, and its dispatch is refused naming the pane, its project by slug, and the command that
ends it with every value filled in — `forge-runner master kill <slug>` for a master pane, and
`tmux -S <runner socket> kill-session -t =<pane>` for a job pane or a record carrying no slug; a
session no record names
is let through with a degraded mark naming it, because a pane placed before capabilities carried
their pane cannot be told from one this box did not place. Where either read fails, the mark says
which. The hook still denies nothing the daemon did not place — the regression ISS-1296 was dropped
for stays refused.

## Residuals shape 1 leaves standing

**A box-level surface for a deaf fleet.** ISS-1208's Rules say a fleet in which every master is deaf
"is a condition of the box, not of four projects, and is surfaced as one" — and the one record the
sweep writes is a daemon log line. An operator at `forge-runner master status` still assembles the
box-level condition from project rows. Whoever takes it decides whether a box-level row belongs in
`master_authority` at all or is derived from the per-project rows at print time. Shape 1 makes a
deaf fleet rarer — a re-mint no longer deafens a pane carrying a record — and does not surface it.

**A withdrawal that could not be written, across a daemon restart.** Where a placement mints a
capability and then places no pane, the box withdraws the mint; a withdrawal that could not be
written leaves the entry in the map, and the `Masters` registry's `unwithdrawn` marker is what stops
the verdict reading `current`. That marker is in the process and nowhere else, so a daemon restarted
while an entry is still unwithdrawn reads the map at face value again. The record does not change
this: the write that would record the fact is the write that failed.

**A pane replaced under the same name by something this box did not start**, between
`terminal::kill` and the `new-session`. Narrow, and nothing observed has hit it. The record names a
pane by its tmux session name; the reading that would close it is a pane incarnation carried
through the placement.

**An undecided dispatch cannot be attributed to the run it belonged to.** ISS-1192 stamps a run
with `gateAtOpen`, the box's gate condition when the run opened, and refused per-dispatch evidence
because the mark is written by a process that could not reach the daemon. The hook can now name the
pane it runs in; making the mark name the declared run the pane holds is still unbuilt, and until it
is, `gateAtOpen` says what it is, and says it is the box's.

**Closing a run declared under a previous pane.** `carried_across` moves only runs whose recorded
process runs beneath the adopted pane, which a replaced pane's never do. A run declared by a pane that has since been replaced by a different one stays under
that pane's session and its successor cannot close it — ISS-1355's deliverable.

## Honest costs

What adopting shape 1 took, and what it still costs.

| Cost | What it buys, and who pays |
|---|---|
| A format change to `control-tokens.json` with a total failure mode | A file this daemon cannot parse answers for no pane, so every live master on the box is refused until the file is repaired. The reader accepts both shapes and refuses only a file in neither, by name; the refusal is tested against a record file, a pre-record file, a mixed file and four files in neither shape. Every box pays the risk; the one box with a torn file pays the outage |
| Two daemon versions read one file | A daemon older than forge-runner 0.17.72 parses only `token -> string`, so a downgrade reads a file holding a record as not a map and refuses every frame by name — it does not overwrite it (`cf22738f9`, `runner-v0.15.0` and later). Rolling back past 0.17.72 therefore owes removing `control-tokens.json` and ending the master panes so each is placed again; that is the version floor, stated rather than enforced. 0.17.72 itself reads a record carrying a slug, since `Minted` ignores a field it does not declare |
| The declaration bound moved | It sits in `control.rs:declaring_project` rather than behind the registry's session map, and every argument ISS-1050 criterion 7 made had to be re-established there by a reviewer. A later change to what a record holds re-opens that pass |
| Pre-record capabilities keep their old failure until replaced | A pane placed before the upgrade still loses its authority when core replaces its row, and ISS-1208 then ends it — killing its subagents — to place one carrying a record. That bill arrives at most once per pane |
| Entries nobody retires | `retire` removes by session and `retire_pane` by pane when a master ends; a mint removes every earlier entry for its session and for its project and pane. An entry whose pane never started and whose project is never placed again is carried through every rewrite, and a pre-record entry naming a session core never heard of is carried as written, since rewriting it would decide afterwards what it was for |
