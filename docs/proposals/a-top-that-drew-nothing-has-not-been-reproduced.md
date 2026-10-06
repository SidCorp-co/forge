# A `forge-runner top` that drew nothing has not been reproduced

ISS-1344's judge j3 (session `iss-1344-e83d49cf`) noted this outside every criterion, at d2e5e70 on
2026-10-06. It reported that `forge-runner top`, run under a pty against
`--core-url http://127.0.0.1:9`, drew no frame for about two minutes and was still running after
`timeout 8` sent it SIGTERM. The judge did not look into it further and called it unexplained. It is
recorded here, not filed, because the rules route a residual like this to a proposal rather than to a
new issue.

## What was measured, and did not happen

ISS-1344's repair round r3 ran it three times on 2026-10-07 at `2a574c7`. Each run used a debug
build from that tree. A Python pty read the screen, sent SIGTERM after the read window, and timed the
exit.

| Run | Environment | First byte | Frames drawn | Exit after SIGTERM |
|---|---|---|---|---|
| 1 | scratch HOME, XDG_CONFIG_HOME and XDG_DATA_HOME | 0.01s | 3 in 8s | 0.00s, status 0 |
| 2 | the box's own environment, read only: 6 of 10 master panes up, 3 leased runs | 0.01s | 3 in 8s | 0.01s, status 0 |
| 3 | `timeout 8 forge-runner top …` as the pty's command | 0.02s | 3 in 8s | timeout's 124 at 8s, nothing left running |

`cmd::top::run` writes the header and "reading this box's sources for the first frame…" before its
first gather. It hears SIGINT, SIGTERM and SIGQUIT through `Interrupt`, and each one ends the view.

## What would explain it, untested

The judge's harness is not on the record, so neither of these has been checked against it.

- **The terminal was not the foreground process group's.** `keys::open` sets raw mode. A process in a
  background group that changes the terminal's modes is stopped by SIGTTOU before it writes a byte.
  A stopped process does not act on SIGTERM until it gets SIGCONT, and the stop comes back when the
  call is retried.
- **A first gather that blocks a runtime worker.** The gather is a spawned task, and some of its
  reads block. `run` returns on a signal, but the runtime's shutdown still waits for a worker that is
  inside a blocking call. Run 2 read the box's live sources and finished its first gather within
  seconds, so this would take a source slower than this box's.

The next step is to rerun the judge's exact command line and record the process state (`ps -o stat`)
while it is drawing nothing. A `T` there confirms the first explanation. An `S` with a gather stack
confirms the second.
