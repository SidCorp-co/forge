# A runner socket moved under a running server orphans its masters

Met while working ISS-1265 round 4. That round stopped the runner reading tmux's
`error connecting to <sock> (No such file or directory)` as a session that ended: a socket file
moved or deleted under a running server leaves every master on it running, and tmux says the same
words for a socket never made. The runner now treats that answer as a question nobody answered. It
sends no ack, recovery reads `Unanswered`, `kill` reports an error, and one line names the socket
and the panes this daemon placed on it.

What follows is out of that row's reach, and is written down here rather than filed.

## The next placement starts a different server on the same path

`packages/runner/crates/forge-runner-core/src/daemon/terminal.rs:ensure` places a pane after
`ensure_server`. With the socket file gone, `server_answers` is false. `ask_systemd_for_the_server`
finds the session unit still running, because the old server is that unit, and reports `Accepted`.
The socket never answers, so `hold_the_keepalive_here` runs `new-session`. tmux then starts a fresh
server and creates a new socket file at the same path.

From then on every question reaches the new server. It answers `can't find session` for each
master the old server still runs, which is an honest answer about a different server, so
`has_session` reads `Absent`. The inbox acks `gone` and recovery closes those runs, while their
panes keep running where nothing can reach them.

The orphaning can be detected without a guess. tmux recreates a removed socket when its server is
sent `SIGUSR1` (tmux(1), *"If the socket is accidentally removed"*), and the session unit's
`MainPID` names that server where systemd placed it. Before it places anything, the daemon could see that the unit is running
while the socket file is gone, signal the server, and ask again.

## What ends it

A placement decision has to be taken: on a running unit whose socket file is gone, the daemon
recreates the file with `SIGUSR1`, or it refuses to place and says so, or it adopts the old server
some other way. Each of these is a change to `ensure_server`, which is a decision about placement.
The master's ruling for ISS-1265 covered how the answer is read and said to read nothing else to
guess the server's liveness.

The evidence is the state `daemon::terminal::testing::MovedSocket` builds, with an `ensure` taken
while it holds.

## Honest costs

- **Recreating the socket file costs a signal sent to a process the daemon did not start in this
  life.** The pid comes from systemd's record of the unit. On a box where that record is wrong, the
  signal reaches another process, and `SIGUSR1` terminates a process that does not handle it.
- **Refusing to place costs every new master on the box** until a person puts the socket file
  back, and a person has to read the line before they know that is the fix.
- **Leaving it costs the masters on the old server.** After the next placement they read as gone,
  which is the outcome ISS-1265 exists to stop, reached one step later than judge-51's route.
