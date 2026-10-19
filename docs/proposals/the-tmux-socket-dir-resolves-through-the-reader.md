# The tmux socket's directory resolves through the config reader, not the writer

Routed to ISS-1265 from ISS-1344 (comment 3b006574) while `daemon/terminal.rs` was held, and not
taken in ISS-1265's round-3 repair. Left here because the move changes which tmux server every test
in the runner crate reaches on three platforms, and that is a decision about the test harness rather
than about the inbox's acks.

## What stands

`packages/runner/crates/forge-runner-core/src/daemon/terminal.rs:session_config_dir` resolves the
directory the tmux server creates its socket in through `Config::path`, the readers' resolution.
ISS-1344's `config::base_dir` is the writers' resolution, and in a test build it refuses any
directory that is not a `test_scratch::Scratch`. The `#[expect(clippy::disallowed_methods)]` on
`session_config_dir`, and terminal.rs's entry in
`config::tests::every_other_resolution_of_the_config_dir_is_a_counted_reader`, price it.

Measured by ISS-1344: no test starts a server there unscoped. A full `cargo test --workspace
--no-fail-fast` with `XDG_CONFIG_HOME` pointed at a sentinel outside the temp dir left the sentinel
empty. Every `IsolatedServer` and `Sandbox` caller holds `cred_store::ENV_TEST_LOCK` on `main` at
`fd5aa27`, which was the second half of that routing (comment 7e9dc356).

## What taking it decides

- **Where an unscoped test build's tmux goes.** With `base_dir`, an unscoped test resolves no
  socket, and `socket_args` then passes no `-S`, so tmux reaches the default server, the one a
  person's own sessions run on. Today it reaches `~/.config/forge-runner/tmux.sock`, the live
  session server. The move is only an improvement once an unscoped test build resolves a socket no
  server can be on.
- **What macOS and Windows tests run.** `base_dir`'s `os_dir` honours a scratch `XDG_CONFIG_HOME`
  on every platform in a test build, where `Config::path` does not off Linux. `IsolatedServer::took`
  and `Sandbox::new` would start reporting isolation on macOS, and the tmux tests they gate would
  start running there.
- **Four tests that compare against the box's own directory.**
  `the_boxs_own_config_dir_resolves_the_bare_session_unit`,
  `the_unoverridden_dir_is_what_the_box_resolves_with_no_override`,
  `a_config_dir_reached_through_an_alias_is_still_the_boxs_own` and the `..` spelling inside it read
  `session_config_dir` or `session_unit` under a non-scratch `XDG_CONFIG_HOME`. Under the guard they
  resolve nothing, and two would pass for the wrong reason. They become tests of `unit_for` on the
  directory itself.

## What ends it

One change that takes all three: `session_config_dir` reads `config::base_dir`, a test build with no
scoped directory resolves a socket path nothing can serve, the four tests move to `unit_for`, the
counted-reader entry drops by one, and the runner's macOS and Windows legs are run on the branch
before it lands.

## Honest costs

- **Taking it costs a run on the macOS and Windows legs before it lands.** Which tmux tests run
  there changes, and no box here runs either leg, so the branch cannot be judged locally.
- **Taking it costs four tests' subject.** Moved onto `unit_for`, they stop proving that the
  production resolution with no override is the box's own directory, and nothing in a test build can
  prove that once the resolution refuses a non-scratch directory.
- **Leaving it costs a test build that resolves the live session server's socket by default.** A
  future tmux test that forgets `IsolatedServer` reaches the server live masters run on, and only
  the review of that test stands between it and them.
