# A pane's control capability cannot outlive the session row it names

**Status:** open residual, measured in the field and now announced in code. No fix proposed here,
because the alternatives all change what a control-socket capability *is*, and that identity is
what ISS-1050 criterion 7 and ISS-964 criterion 29 are both written against.

**Found by:** ISS-1092, working out why the `home-kieutrung-services-anhome` master on forge-vm
could not dispatch. The issue's own hypothesis — that the project was missing from what core
reports this device serves — was measured false: the project is listed, `online`, with a repo path.

## What is true today

A master pane carries one capability, `FORGE_CONTROL_TOKEN`, minted at spawn into the pane's
environment. `daemon/session_tokens.rs` maps that token to the core `agent_sessions` id the pane was
registered under, and `run_declare` resolves the caller through it. A pane cannot be handed a new
one: its environment is fixed at exec, so `ensure_master` mints on the spawn path only, and the
`cm:guard` there says why — re-minting for an adopted pane would refuse every frame it sends for the
rest of its life.

Core's side is `devices/master-session.ts:ensureMasterSession`, which reuses a master session row
only while it is **non-terminal**, and reaps one whose heartbeat stops.

So a pane's capability is valid exactly as long as its session row stays alive. When the row goes
terminal under a still-running pane, the next registration creates a second row, the daemon adopts
the pane onto that new row, and the pane's own token names the old one for good. Nothing reconciles
the two, and nothing can: the pane cannot be told.

## What ISS-1092 did about it

Two halves, both landed:

- The heartbeat gap that caused it is closed. The sweep used to skip `ensure_master` entirely for a
  project with nothing admissible, which also skipped the registration that keeps the row beating —
  measured at 14 hours on forge-vm across a daemon restart, ending in exactly the state above.
  `Placement::AdoptOnly` keeps the registration while still starting no master.
- The state is now *reported* rather than silent. `ensure_master` logs at error when it adopts a
  live pane onto a session row core created fresh, and `run_declare` refuses such a pane by saying
  its capability is stale and that the pane has to be replaced.

## What is still true after it

The state is recoverable only by ending the pane. A drained runner still skips placement, so a
project drained for longer than core's heartbeat window reaches the same state by a different road;
so does any outage long enough for core to reap the row while the box cannot reach it.

## What a fix would have to decide

Three shapes, none of them free:

1. **Put the project in the capability.** The token store would hold `token -> {session, project,
   pane}` instead of `token -> session`, and `run_declare` would resolve the project from the record
   the daemon itself minted rather than from a map keyed by a session id that can be replaced. This
   is not deriving the project from the caller's claim — the daemon wrote the record at spawn, for a
   pane it spawned — but it does move where the bound lives, which is the thing ISS-1050 criterion 7
   is written about, and it needs a format migration whose failure mode is "no pane on this box has
   a capability".
2. **Re-point the entry on adoption.** Keep the token string and change what it resolves to when the
   daemon adopts a pane onto a new row. Needs the store to know which entry belongs to which pane,
   which it does not today.
3. **Let core keep the row alive on the box's word.** Move the reaping decision to something that
   can see the pane, rather than to a heartbeat the box may stop sending for reasons that are not
   the pane's fault.

Each is a decision about the identity model rather than a bug fix, which is why it is here and not
in ISS-1092's diff.

## Honest costs

What adopting one of the three shapes above takes from whoever adopts it.

| Shape | What it costs |
|---|---|
| 1 — project in the capability | A format change to `control-tokens.json`, whose failure mode is total: a file this daemon cannot parse reads as "no pane on this box has a capability", and every live master on a 28-project box is refused at once until each pane is replaced. The reader has to be written to accept both shapes and to shout rather than default. |
| 1 — project in the capability | It moves where the declaration's bound lives, from a map the sweep maintains to a record written at spawn. Every argument ISS-1050 criterion 7 makes has to be re-made against the new location, by a reviewer, before it can be trusted. |
| 2 — re-point on adoption | The store has to learn which pane an entry belongs to, which makes `pane_name` a unique key it does not have today; two entries for one pane become a state somebody has to decide about. |
| 2 — re-point on adoption | It hands the daemon the power to change what an existing capability means. Today a token's meaning is fixed at mint, which is a property worth something on its own. |
| 3 — core keeps the row on the box's word | Core stops being able to reap a master row on its own evidence, so a box that dies without saying so leaves live master rows that nothing closes — the hole ISS-919 B1 was filed to close, reopened from the other side. |
| All three | None of them helps a pane already in this state on a running box. That pane is replaced either way, so whoever adopts one of these is paying for the next occurrence and not this one. |
