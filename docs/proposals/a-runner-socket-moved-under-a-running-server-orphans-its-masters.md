# A runner socket moved under a running server orphans its masters, off Linux when no process check finds the server

Met while working ISS-1265. A tmux socket file moved or deleted under a running server leaves every
master on it running, and the next placement used to start a second server on the same path, which
answers `can't find session` for each of them, so the inbox acked them `gone`.

`packages/runner/crates/forge-runner-core/src/daemon/terminal.rs:ensure` refuses that placement
while a server still runs on the path, by `missing_socket::placement_refused`. Whether one runs is
asked each time, never read off the record of placed panes, because that record outlives the server
that ran them (round 6, judge-64: a server stopped by hand with its stale file removed locked every
placement out until the daemon restarted). Two reads answer it, in `missing_socket::serving`:

- **The kernel's listing**, on Linux: `/proc/net/unix` still lists a server listening on the path
  after its file is gone, and lists nothing once that server has exited.
- **The process the runner started as the server**: `pgrep -of` on a command line that runs tmux
  with `-S <path> new-session`, the argv both routes here start every server with, and the command
  the refusal names. For tmux's
  default server, which carries no `-S`, it is the pid that server gave when a pane was placed on
  it, counted only while `ps` shows the same process start and an argv naming tmux.

A readable listing decides alone, because a tmux server holds its listening socket until it exits;
the process check then only supplies the pid. Where no listing is read, a matching process stands
in for it. A server found this way refuses the placement, naming the socket, the panes still placed
on it, and how to send the server `SIGUSR1`, which makes tmux recreate the file: `kill -USR1`
with the pid the process check found, or, where it found none, the `pgrep` that finds it. A
default server whose recorded pid has since exited or passed to another process is never named
to signal; the line says no tmux server holds that pid now and names `ss -xlp src <path>`, which
finds the process still listening on the path. A
readable listing with no listener, or off Linux a process check that ran and found none, means the
server has ended: the panes placed on it are logged once as ended with it, and the placement starts
a fresh server. The record also drops a pane wherever tmux reports it gone, by `has_session` or by a
full listing of the sessions.

## What is still open

Off Linux, where no kernel listing is read, a server on that path that was not started as
`tmux -S <path> new-session` — started by hand, say — is found by neither read. Its file gone, the
next placement starts the second server and the orphaning follows as before.

## What ends it

A portable way to ask the kernel whether a process still listens on a unix socket path whose file
is gone, or a way for a person's own tmux on the runner's socket to carry the same argv.

## Honest costs

- **A refused placement costs every new pane on the box** until a person sends the server
  `SIGUSR1` or puts the file back. The refusal names the command and the pid, and is said again at
  warning level once a minute while placements keep being refused; nothing signals the server for
  them.
- **An unreadable `/proc/net/unix` also refuses**, with the file gone and no process found, rather
  than reading as no server, so a Linux box hiding that listing cannot cold-start on a socket never
  made.
