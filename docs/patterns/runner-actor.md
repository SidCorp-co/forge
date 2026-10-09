# Runner actor

**Change kind:** Runner actor
**Introduced by:** ISS-466

A long-lived task of the `forge-runner` daemon: one per component, owning its own state, woken by
a tick or a frame, and stopped when the daemon's `watch` cancel says so. The runner does only what
the machine alone can do and every decision belongs to core
([ADR 0009](../adr/0009-the-runner-is-a-thin-box-agent.md)), so an actor reports conditions and
carries out what core decided; it decides nothing core could. A change takes this entry when it
adds an actor, changes what one does on its tick or frame, or changes how the daemon starts or stops
one. It reaches core only through REST routes and frames built to the [API route](api-route.md) entry.

## Reference

- `packages/runner/crates/runner-daemon/src/actors.rs` — the actors: `Ticks` (the wait before the work, ending on cancel), `heartbeat`, `provision_sweep`, `worktree_reap`, `on_frame`
- `packages/runner/crates/runner-daemon/src/lib.rs` — where each actor is spawned with its own clone of the cancel receiver
- `packages/runner/README.md` — the crate layout and the dependency order between crates
- `packages/runner/clippy.toml` — the function-length limit the crate holds
- `scripts/check-runner-gates.mjs` — the gates a runner change passes: `cargo metadata --locked`, `fmt --check`, `clippy -D warnings`, `test`, and the file-size limit

## Test shape

- `packages/runner/crates/runner-daemon/src/actors/cancel_tests.rs` — an actor's frame handled end to end: a real tmux pane on a scratch socket, a core on a loopback port recording what the box sent, and the assertion on the pane closed, the slot freed and the ack sent
- `packages/runner/crates/runner-daemon/src/pool_jobs/tests.rs` — the logic behind an actor tested through its port traits with in-memory fakes, no network and no tmux

A new actor's decision logic sits behind a trait the test fakes, tested in a **tests.rs** or
`*_tests.rs` module declared `#[cfg(test)]` beside it; what needs the machine (tmux, a process, a
socket) is tested against a scratch instance the test owns and removes, and skips by name where the
tool is absent. `cargo test --workspace` collects both, run by `scripts/check-runner-gates.mjs` when
`packages/runner` changed. The test asserts what the box sent to core and what it did on the
machine, and that the actor stops on cancel.

## Review checklist

1. The actor decides nothing core could decide; it reports a condition or carries out an instruction core sent.
2. It runs on `Ticks` or a frame and ends when its cancel receiver says so; it holds no state another actor writes.
3. It is spawned once in **lib.rs** with its own cancel receiver clone, and nothing else starts it.
4. A failure is logged with the actor's tag and the loop goes on; it never panics the daemon or exits silently.
5. Its first run comes after its first wait, so a restart does not run it twice in a row.
6. It calls core only through a REST route or answers a frame; no endpoint is invented on the box side.
7. Functions stay under clippy's limit and files under the gate's limit; `fmt` and `clippy -D warnings` pass.
8. Anything it leaves on the machine (a pane, a file, a process) is reaped by it or by a named sweep.
