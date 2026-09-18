# Non-issue work reaches a master through a second door

**Refused by ISS-1094, and named here rather than approximated.** ISS-1094 shipped the declaration
gate and fixed the master's guide. It did not ship the beat of its own contract that reads *"work
with no issue behind it reaches the master through the same 'what do I do next' door it already uses
for issues, not through a second one"*.

## What stands today

Two doors, and only one of them is the master's.

- `GET /api/devices/me/issues/admissible` (`packages/core/src/devices/admissible.ts`) serves issues.
- `GET /api/devices/me/pool` (`packages/core/src/devices/pool-routes.ts`) serves the four kinds that
  have no issue — `smoke`, `release_batch`, `reconcile`, `verify_skill`. Its only reader is the
  daemon (`packages/runner/crates/forge-runner-core/src/daemon/pool_jobs.rs`), which opens a
  terminal of its own per job. The route is `requireDevice`, so a master, which holds a PAT, cannot
  read it at all.

## Why it was not built here

The master does not read either route directly. It reads whatever its ranking verb prints, and that
verb is the `forge` CLI's — `github.com/SidCorp-co/forge-plugin`, which a job in this repository
does not edit. Core can serve non-issue work on a door a master can reach; only that CLI can put it
in the one list the master reads. So the beat has a half this repository cannot write.

Building the core half alone was considered and refused: a route with no reader is the shape
`pool-routes.ts`'s own guard names, and one built speculatively for a plugin change nobody has
designed yet is indistinguishable, six months on, from a live path.

## What that leaves

Nothing was removed, so the ordering rule ISS-1094 states — *the path must exist and a master must
be able to run it before the old lane goes* — is satisfied trivially. Every box keeps the ability to
release. The cost is that the daemon's lane stays invisible to the master: it is not counted against
a wave's width, and when it wedges, the box goes quiet with one log line saying the session count is
full.

The forge-plugin half is filed on that project's own backlog. The core half belongs with it, and
belongs to whoever picks up that row — not to a second row here that nothing would age.

## Honest costs

| What it costs | Who pays it |
|---|---|
| Two halves on two release clocks, sequenced: a core door a PAT can read, then the plugin's ranking verb printing non-issue work beside issues. | Whoever takes the row. |
| Neither half is worth landing alone — a door with no reader is dead configuration, and a verb printing rows core does not serve prints nothing. | Whoever takes the row. |
| The daemon's lane stays up throughout, and comes out only once a master has been seen running that work. | The fleet, for as long as it takes. |
| Until then: the second lane is invisible to the master, is not counted against a wave's width, and takes the box quiet with it when it wedges. | Every box, today. |
