# A runner socket moved under a running server orphans its masters, off Linux after a restart

Met while working ISS-1265. A tmux socket file moved or deleted under a running server leaves every
master on it running, and the next placement used to start a second server on the same path, which
answers `can't find session` for each of them, so the inbox acked them `gone`.

Since round 5, `packages/runner/crates/forge-runner-core/src/daemon/terminal.rs:ensure` refuses that
placement while panes are placed on the socket, by `missing_socket::placement_refused`. "Placed" has
two sources: the panes this daemon placed on that socket and has not ended, held in memory, and, on
Linux, `/proc/net/unix`, which still lists the old server listening on the path after its file is
gone. The refusal names the socket, the panes, and how to find the server and send it `SIGUSR1`,
which makes tmux recreate the file.

## What is still open

A daemon restarted while the file is gone, on a box with no `/proc/net/unix` (macOS), holds neither
source. Its in-memory record is empty, so its first placement starts the second server and the
orphaning follows as before.

## What ends it

A record of placed panes that survives a restart and is keyed by socket, or a portable way to ask
the kernel whether a process still listens on a unix socket path whose file is gone. The ledger's
`masters` rows do not serve: they record no socket, and the ledger lives under the data dir while the
socket lives under the config dir, so a box running two runners would read one runner's masters as
placed on the other's socket.

## Honest costs

- **A refused placement costs every new pane on the box** until a person sends the server
  `SIGUSR1` or puts the file back. The refusal line names the command; nothing retries it for them.
- **An unreadable `/proc/net/unix` also refuses**, with the file gone, rather than reading as no
  server, so a Linux box hiding that listing cannot cold-start on a socket never made.
