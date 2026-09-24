# The hook sweep's call sites are proved by reading source

**Status:** residual of ISS-1200, left standing deliberately. Not a defect in shipped behaviour —
the behaviour was driven live and holds. A defect in what proves it.

## What is proved by reading source rather than by running

Two cases in the runner assert something about production source *text* instead of about what the
code does:

- `daemon/mod.rs:the_sweep_runs_at_boot_and_again_the_moment_an_update_replaces_the_binary`
  asserts that `mod.rs` contains the literal `repair_installed_hooks(server.as_deref(), &cfg,
  "boot")`, that the after-update call is handed what `list_me` returned, and that both appear
  before `drain_to_idle` in the file.
- `update/mod.rs:the_install_target_is_resolved_rather_than_read_off_proc_self_exe` asserts that
  `apply`'s body does not contain `current_exe()` and does contain `crate::exe::own()`.

Both go red on a rename or a reformat that changes no behaviour, and both stay green if the call
they guard is moved somewhere it never runs. A green from either says the source spells something,
which is not the proposition anybody wants.

## Why they were not replaced

The sweep this guards is what `hook_install::repair` does, and that function is driven directly by
several cases that run it — over a real checkout, from a process whose `/proc/<pid>/exe` carries
the kernel's own `(deleted)` annotation, in
`packages/runner/crates/forge-runner/tests/replaced_binary_hooks.rs`. What is NOT reachable is the
two *call sites*: one sits inside `daemon::run`, past the credential store, the core client, the
runner pool and the assignment fetch; the other sits inside the update loop's post-apply path,
behind a release manifest and a download. Reaching either from a test means standing up a stub core
and a release server — the fixture ISS-1200's judging run built by hand, outside the tree.

Those two source reads are therefore the only thing standing between a dropped call and a green
suite. They are kept for that reason, and they are worth exactly what a source read is worth.

## What would end it

A test fixture in `packages/runner` that serves a stub core and a release manifest over loopback,
so `daemon::run` can be entered and the update loop driven to its post-apply sweep. With it, both
cases above become assertions about a journal line and a settings file, and both source reads are
deleted rather than annotated.

## What one of them could not see, measured

The third judging run of ISS-1200 failed criterion 8 on the *set* the boot call passed, not on
where it sat: `cfg.bindings` is the local fallback, and a project bound to this device from the web
UI lives in the `runners` table alone, so a poisoned checkout was swept past in silence while the
suite stayed green and the source read said the call was there. The reads now assert what each call
is GIVEN as well as where it stands, which is the narrowest thing that would have caught it — and
still a claim about spelling. A call handed a set derived correctly and then filtered wrongly
somewhere downstream reads exactly the same.

## Honest costs

| Cost | Who pays |
|---|---|
| A rename of `repair_installed_hooks` fails a case whose subject did not move | Whoever renames it, once |
| Moving either call somewhere it never runs leaves the suite green | The next box whose hooks are never repaired, silently, which is the failure ISS-1200 exists to end |
| Handing either call a set that is derived rather than spelled leaves the suite green | The same box, by the route that cost this issue its third round |
